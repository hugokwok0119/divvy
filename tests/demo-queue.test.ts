import { describe, expect, it } from 'vitest';
import sampleResults from '../src/demo/sample-results.json';
import { buildDemoData } from '../src/demo/data';
import { createDemoServer, DEMO_REFUSAL, DEMO_SAMPLE_ONLY } from '../src/demo/server';
import type { SampleResult } from '../src/demo/types';
import { computeShares, type SplitRule, type SplitType } from '../src/lib/settlement';
import { normalizeMerchantName } from '../src/lib/category';
import { validateQueueBulk, validateTxInput } from '../worker/lib/validate';
import type { Bootstrap, ExpenseHistoryEvent, QueueItem, Transaction } from '../src/types';

const samples = sampleResults.samples as SampleResult[];
const NOW = 1_800_000_000_000;
const ROSTER = ['mem_alex', 'mem_sam'];
const CONFLICT = { error: 'Expense changed. Reload its saved version before retrying.' };
type Row = { date: string; store: string; amountCents: number; category: string };

const setup = () => {
  const state = buildDemoData(samples);
  let n = 0;
  const server = createDemoServer(state, samples, { parseDelayMs: 0, now: () => NOW, newId: () => `gen_${++n}` });
  return { state, server };
};
type Server = ReturnType<typeof setup>['server'];
const send = (server: Server, method: string, path: string, body?: unknown) =>
  server.handle(new Request(`https://demo.test${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
const sampleRows = (id: string) => (samples.find((s) => s.id === id)!.body as { transactions: Row[] }).transactions;
const item = (id: string, row: Row, extra: Record<string, unknown> = {}) => ({
  id, date: row.date, store: row.store, amountCents: row.amountCents, category: row.category,
  payerId: 'mem_alex', cardId: 'card_demo_visa', splitType: null, splitRule: null, source: 'image', ...extra,
});
const importRows = async (server: Server, prefix: string, rows: Row[]) => {
  const res = await send(server, 'POST', '/api/queue/bulk', { items: rows.map((row, i) => item(`${prefix}_${i}`, row)) });
  return { res, body: await res.json() as { created: Array<QueueItem & { createdAt: number }>; summary: { inserted: number; duplicate: number; rejected: number } } };
};
const bootstrap = async (server: Server) => (await send(server, 'GET', '/api/bootstrap')).json() as Promise<Bootstrap>;
const txBody = (row: QueueItem, id: string, splitType: SplitType, splitRule: SplitRule | null) => ({
  id, date: row.date, store: row.store, amountCents: row.amountCents, category: row.category ?? 'Other',
  payerId: 'mem_alex', cardId: 'card_demo_visa', splitType, splitRule,
});

describe('demo bulk import', () => {
  it('imports sample-a1 rows as Alex and flags the two seeded matches', async () => {
    const { state, server } = setup();
    const rows = sampleRows('sample-a1');
    const before = state.bootstrap.queue.length;
    const { res, body } = await importRows(server, 'a1', rows);
    expect(res.status).toBe(201);
    expect(body.summary).toEqual({ inserted: rows.length, duplicate: 2, rejected: 0 });
    expect(body.created.filter((row) => row.isDuplicate === 1)).toHaveLength(2);
    expect(body.created[0]).toMatchObject({ id: 'a1_0', householdId: 'hh_demo', revision: 1, editedByMemberId: 'mem_alex',
      editedByName: 'Alex', hasBeenApproved: false, updatedAt: NOW, createdAt: NOW, source: 'image', reviewNote: null });
    expect((await bootstrap(server)).queue).toHaveLength(before + rows.length);
    const imported = state.history.filter((e) => e.eventType === 'imported');
    expect(imported).toHaveLength(rows.length);
    expect(imported[0]).toMatchObject({ expenseId: body.created[0].expenseId, actorMemberId: 'mem_alex', actorName: 'Alex',
      timestamp: NOW, before: null, reviewNote: null });
    expect(imported[0].after).toEqual(Object.fromEntries([...Object.entries(body.created[0])
      .filter(([key]) => key !== 'householdId'), ['state', 'pending']]));
  });

  it('flags the sample-a3 same-day repeat', async () => {
    const rows = sampleRows('sample-a3');
    const later = rows.findIndex((row, i) => rows.slice(0, i).some((r) => r.store === row.store
      && r.date === row.date && r.amountCents === row.amountCents));
    expect(later).toBeGreaterThan(0);
    const { body } = await importRows(setup().server, 'a3', rows);
    expect(body.created[later].isDuplicate).toBe(1);
  });

  it('attributes imports to the current member', async () => {
    const { state, server } = setup();
    state.bootstrap.me.memberId = 'mem_sam';
    const { body } = await importRows(server, 'x', sampleRows('sample-a1').slice(0, 1));
    expect(body.created[0]).toMatchObject({ editedByMemberId: 'mem_sam', editedByName: 'Sam' });
    expect(state.history.at(-1)).toMatchObject({ actorMemberId: 'mem_sam', actorName: 'Sam' });
  });

  it('refuses CSV rows', async () => {
    const { state, server } = setup();
    const before = JSON.stringify(state);
    const rows = sampleRows('sample-a1');
    const res = await send(server, 'POST', '/api/queue/bulk', { items: [item('c0', rows[0]), item('c1', rows[1], { source: 'csv' })] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: DEMO_SAMPLE_ONLY, reason: 'demo_sample_only' });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('counts reused ids as rejected', async () => {
    const { state, server } = setup();
    const [row] = sampleRows('sample-a1');
    await importRows(server, 'r', [row]);
    const again = await importRows(server, 'r', [row]);
    expect(again.res.status).toBe(201);
    expect(again.body.summary).toEqual({ inserted: 0, duplicate: 0, rejected: 1 });
    // A deleted row's id stays consumed, as the server's imported history marks it.
    expect((await send(server, 'DELETE', '/api/queue/r_0', { revision: 1 })).status).toBe(204);
    expect((await importRows(server, 'r', [row])).body.summary.rejected).toBe(1);
    const seeded = state.bootstrap.queue[0];
    const res = await send(server, 'POST', '/api/queue/bulk', { items: [item(seeded.id, row)] });
    expect((await res.json() as { summary: unknown }).summary).toEqual({ inserted: 0, duplicate: 0, rejected: 1 });
  });

  it("rejects invalid input with the server's fields", async () => {
    const { state, server } = setup();
    const body = { items: [item('bad', sampleRows('sample-a1')[0], { amountCents: 'x' })] };
    const res = await send(server, 'POST', '/api/queue/bulk', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid queue import', fields: validateQueueBulk(body, ROSTER).fields });
    expect(state.history.some((e) => e.eventType === 'imported')).toBe(false);
  });

  it('checks payer and card ownership before writing', async () => {
    const { state, server } = setup();
    const [row] = sampleRows('sample-a1');
    for (const [extra, error] of [
      [{ payerId: 'mem_nobody' }, 'Unknown payer'], [{ cardId: 'card_nobody' }, 'Unknown card'],
      [{ payerId: 'mem_sam' }, 'Card does not belong to the payer'],
    ] as const) {
      const res = await send(server, 'POST', '/api/queue/bulk', { items: [item('ok', row), item('bad', row, extra)] });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error });
    }
    expect(state.bootstrap.queue.some((q) => q.id === 'ok')).toBe(false);
  });
});

describe('demo Pending edits', () => {
  it('patch returns 409 on stale revision', async () => {
    const { state, server } = setup();
    const row = state.bootstrap.queue[0];
    const res = await send(server, 'PATCH', `/api/queue/${row.id}`, { revision: 2, store: 'Elsewhere' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(CONFLICT);
    expect(state.bootstrap.queue[0]).toEqual(row);
  });

  it('patch validates the revision, body and row', async () => {
    const { state, server } = setup();
    const id = state.bootstrap.queue[0].id;
    let res = await send(server, 'PATCH', `/api/queue/${id}`, { store: 'X' });
    expect([res.status, await res.json()]).toEqual([400, { error: 'Expected expense revision' }]);
    res = await send(server, 'PATCH', `/api/queue/${id}`, { revision: 1, amountCents: 'x' });
    expect([res.status, await res.json()]).toEqual([400, { error: 'Invalid queue item', fields: { amountCents: 'Expected an integer or null' } }]);
    res = await send(server, 'PATCH', '/api/queue/missing', { revision: 1 });
    expect([res.status, await res.json()]).toEqual([404, { error: 'Queue item not found' }]);
    res = await send(server, 'PATCH', `/api/queue/${id}`, { revision: 1, splitType: 'custom',
      splitRule: { percentages: { mem_alex: 50, mem_sam: 40 } } });
    expect([res.status, await res.json()]).toEqual([400, { error: 'Custom percentages must total 100%.' }]);
  });

  it('patch no-op keeps the revision', async () => {
    const { state, server } = setup();
    const row = state.bootstrap.queue[0];
    const res = await send(server, 'PATCH', `/api/queue/${row.id}`, { revision: 1, store: row.store });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(row);
    expect(state.bootstrap.queue[0].revision).toBe(1);
  });

  it('patch rejects a card that does not belong to the payer', async () => {
    const { state, server } = setup();
    const row = state.bootstrap.queue[0];
    const res = await send(server, 'PATCH', `/api/queue/${row.id}`, { revision: 1, payerId: 'mem_sam', cardId: 'card_demo_visa' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Card does not belong to the payer' });
    expect(state.bootstrap.queue[0]).toEqual(row);
  });

  it('patch keeps the previous Pending editor and bumps the revision', async () => {
    const { state, server } = setup();
    const row = state.bootstrap.queue[0];
    Object.assign(row, { editedByMemberId: 'mem_sam', editedByName: 'Sam' });
    const res = await send(server, 'PATCH', `/api/queue/${row.id}`, { revision: 1, amountCents: 4321 });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved).toEqual({ ...row, amountCents: 4321, revision: 2, updatedAt: NOW,
      editedByMemberId: 'mem_sam', editedByName: 'Sam', lastEditedAt: null });
    expect(state.bootstrap.queue[0]).toEqual(saved);
  });

  it('confirm of a previously approved row is refused', async () => {
    const { state, server } = setup();
    const row = state.bootstrap.queue[0];
    row.hasBeenApproved = true;
    const confirm = await send(server, 'POST', `/api/queue/${row.id}/confirm`,
      { revision: row.revision, transactionId: 'tx_a', transaction: txBody(row, row.id, 'equal', null) });
    expect([confirm.status, await confirm.json()]).toEqual([403, { error: DEMO_REFUSAL, reason: 'demo_read_only' }]);
  });

  it('patch category saves a preference', async () => {
    const { state, server } = setup();
    const row = state.bootstrap.queue.find((q) => q.store && q.category !== 'Subscriptions')!;
    const res = await send(server, 'PATCH', `/api/queue/${row.id}`, { revision: 1, category: 'Software & Subscriptions' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ category: 'Subscriptions', revision: 2 });
    expect((await bootstrap(server)).categoryPreferences[normalizeMerchantName(row.store!)]).toBe('Subscriptions');
  });
});

describe('demo Pending deletes', () => {
  it('delete and delete-bulk remove rows', async () => {
    const { state, server } = setup();
    const [a, b, c] = state.bootstrap.queue;
    let res = await send(server, 'DELETE', `/api/queue/${a.id}`, { revision: 2 });
    expect([res.status, await res.json()]).toEqual([409, CONFLICT]);
    res = await send(server, 'DELETE', `/api/queue/${a.id}`, {});
    expect([res.status, await res.json()]).toEqual([400, { error: 'Expected expense revision' }]);
    res = await send(server, 'DELETE', `/api/queue/${a.id}`, { revision: 1 });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(state.bootstrap.queue.map((q) => q.id)).toEqual([b.id, c.id]);
    const deleted = state.history.at(-1)!;
    expect(deleted).toMatchObject({ eventType: 'deleted', expenseId: a.expenseId, actorName: 'Alex', timestamp: NOW,
      before: { ...a, state: 'pending' }, after: { ...a, revision: 2, updatedAt: NOW, state: 'deleted' } });

    res = await send(server, 'POST', '/api/queue/delete-bulk', { ids: [b.id, c.id], revisions: { [b.id]: 1, [c.id]: 3 } });
    expect([res.status, await res.json()]).toEqual([409, CONFLICT]);
    res = await send(server, 'POST', '/api/queue/delete-bulk', { ids: [b.id, a.id], revisions: { [b.id]: 1, [a.id]: 1 } });
    expect([res.status, await res.json()]).toEqual([409, CONFLICT]);
    res = await send(server, 'POST', '/api/queue/delete-bulk', { ids: [b.id, c.id], revisions: { [b.id]: 1 } });
    expect([res.status, await res.json()]).toEqual([400, { error: 'Expected revisions for every selected expense' }]);
    res = await send(server, 'POST', '/api/queue/delete-bulk', { ids: [b.id, b.id], revisions: { [b.id]: 1 } });
    expect([res.status, await res.json()]).toEqual([400, { error: 'Invalid queue deletion', fields: { ids: 'Expected unique non-empty ids' } }]);
    res = await send(server, 'POST', '/api/queue/delete-bulk', { ids: [] });
    expect([res.status, await res.json()]).toEqual([400, { error: 'Invalid queue deletion', fields: { ids: 'Expected a non-empty array' } }]);
    expect(state.bootstrap.queue).toHaveLength(2);

    res = await send(server, 'POST', '/api/queue/delete-bulk', { ids: [c.id, b.id], revisions: { [b.id]: 1, [c.id]: 1 } });
    expect([res.status, await res.json()]).toEqual([200, { deletedIds: [c.id, b.id] }]);
    expect(state.bootstrap.queue).toEqual([]);
    expect(state.history.filter((e) => e.eventType === 'deleted')).toHaveLength(3);
  });
});

describe('demo approvals', () => {
  it('confirm moves the row and splits like the server', async () => {
    const { state, server } = setup();
    const { body } = await importRows(server, 'c', sampleRows('sample-b1').slice(0, 3));
    const cases: Array<[SplitType, SplitRule | null]> = [
      ['equal', null], ['single', { memberId: 'mem_sam' }], ['custom', { percentages: { mem_alex: 60, mem_sam: 40 } }],
    ];
    for (const [i, [splitType, splitRule]] of cases.entries()) {
      const row = body.created[i];
      const res = await send(server, 'POST', `/api/queue/${row.id}/confirm`,
        { revision: 1, transactionId: `tx_${i}`, transaction: txBody(row, row.id, splitType, splitRule) });
      expect(res.status).toBe(201);
      const tx = await res.json() as Transaction & Record<string, unknown>;
      expect(tx.splitSharesJson).toBe(JSON.stringify(computeShares(row.amountCents!, splitType, splitRule, ROSTER)));
      expect(tx).toMatchObject({ id: `tx_${i}`, expenseId: row.expenseId, revision: 2, hasBeenApproved: true,
        cardNameSnapshot: 'Demo Visa', editedByMemberId: 'mem_alex', editedByName: 'Alex', source: 'image',
        cycleId: null, householdId: 'hh_demo', createdAt: row.createdAt, deletedAt: null, updatedAt: NOW,
        splitRuleJson: splitRule ? JSON.stringify(splitRule) : null, isStarred: 0, favoriteName: null });
      const boot = await bootstrap(server);
      expect(boot.queue.some((q) => q.id === row.id)).toBe(false);
      expect(boot.transactions.find((t) => t.id === `tx_${i}`)).toEqual(tx);
      const history = await (await send(server, 'GET', `/api/transactions/history/${row.expenseId}`)).json() as ExpenseHistoryEvent[];
      expect(history.map((e) => e.eventType)).toEqual(['approved', 'imported']);
      expect(history[0]).toMatchObject({ before: { id: row.id, state: 'pending' }, after: { id: `tx_${i}`, state: 'approved' } });
    }
    const dates = state.bootstrap.transactions.map((t) => t.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('confirm drops a member who sits out from equal splits, not custom ones', async () => {
    const { state, server } = setup();
    state.bootstrap.members.find((m) => m.id === 'mem_sam')!.sittingOutAt = NOW;
    const { body } = await importRows(server, 'c', sampleRows('sample-b1').slice(0, 2));
    const cases: Array<[SplitType, SplitRule | null, string[]]> = [
      ['equal', null, ['mem_alex']], ['custom', { percentages: { mem_alex: 60, mem_sam: 40 } }, ROSTER],
    ];
    for (const [i, [splitType, splitRule, roster]] of cases.entries()) {
      const row = body.created[i];
      const res = await send(server, 'POST', `/api/queue/${row.id}/confirm`,
        { revision: 1, transactionId: `tx_${i}`, transaction: txBody(row, row.id, splitType, splitRule) });
      expect(res.status).toBe(201);
      const tx = await res.json() as Transaction;
      expect(tx.splitSharesJson).toBe(JSON.stringify(computeShares(row.amountCents!, splitType, splitRule, roster)));
    }
  });

  it('confirm refuses incomplete rows', async () => {
    const { state, server } = setup();
    const row = state.bootstrap.queue.find((q) => q.category === null)!;
    const transaction = { ...txBody(row, row.id, 'equal', null), category: null };
    let res = await send(server, 'POST', `/api/queue/${row.id}/confirm`, { revision: 1, transactionId: 'tx_x', transaction });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid transaction', fields: validateTxInput(transaction, ROSTER).fields });
    res = await send(server, 'POST', `/api/queue/${row.id}/confirm`, { revision: 1, transaction });
    expect([res.status, await res.json()]).toEqual([400, { error: 'Invalid queue confirmation', fields: { transactionId: 'Expected a non-empty string' } }]);
    res = await send(server, 'POST', `/api/queue/${row.id}/confirm`, { transactionId: 'tx_x', transaction });
    expect([res.status, await res.json()]).toEqual([400, { error: 'Expected expense revision' }]);
    expect(state.bootstrap.queue).toContainEqual(row);
  });

  it('approve all with one stale revision', async () => {
    const { state, server } = setup();
    const { body } = await importRows(server, 's', sampleRows('sample-b1').slice(0, 3));
    const before = state.bootstrap.transactions.length;
    const statuses = await Promise.all(body.created.map(async (row, i) => (await send(server, 'POST',
      `/api/queue/${row.id}/confirm`, { revision: i === 1 ? 2 : 1, transactionId: `tx_s${i}`,
        transaction: txBody(row, row.id, 'equal', null) })).status));
    expect(statuses).toEqual([201, 409, 201]);
    expect(state.bootstrap.transactions).toHaveLength(before + 2);
    expect(state.bootstrap.transactions.map((t) => t.id)).toEqual(expect.arrayContaining(['tx_s0', 'tx_s2']));
    expect(state.bootstrap.queue.map((q) => q.id)).toContain(body.created[1].id);
  });
});
