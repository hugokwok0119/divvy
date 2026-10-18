import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';
import { createAuth } from '../../worker/auth';
import app, { type Env } from '../../worker/index';

const db = () => drizzle(env.DB);
const repo = (memberId = 'm1') => new ScopedRepository(db(), 'h1', {
  memberId, displayName: memberId === 'm1' ? 'Sam' : 'Hugo',
});
const input = { id: 't1', date: '2026-10-13', store: 'Market', amountCents: 10000,
  category: 'Groceries', payerId: 'm1', cardId: null, splitType: 'custom' as const,
  splitRule: { percentages: { m1: 70, m2: 30 } } };
const pendingInput = { ...input, id: 'q1', source: 'csv' as const,
  sourceFileId: 'upload-1', sourceFileName: 'statement.csv' };

it('freezes allocation changed in Pending at breakdown rather than later child approval', async () => {
  const original = await repo().insertTransaction({ ...input, splitType: 'single', splitRule: { memberId: 'm1' } });
  const pending = await repo().returnToPending(original.id, original.revision);
  const changed = await repo().updateQueueItem(pending.id, { splitType: 'equal', splitRule: null }, pending.revision);
  const { separated } = await repo().splitQueueItem(changed.id, 'changed-child', 3000, changed.revision);
  await db().insert(householdMembers).values({ id: 'm3', householdId: 'h1', displayName: 'New', createdAt: 0 });
  const child = await repo().confirmQueueItem(separated.id, 'approved-child', { ...input, id: 'approved-child', amountCents: 3000, splitType: 'equal', splitRule: null }, separated.revision);
  expect(JSON.parse(child.splitSharesJson)).toEqual({ m1: 1500, m2: 1500 });
});
it('freezes card changed in Pending at breakdown rather than its later name', async () => {
  await env.DB.exec("INSERT INTO cards (id, household_id, member_id, name) VALUES ('changed-card', 'h1', 'm1', 'At split')");
  const original = await repo().insertTransaction(input);
  const pending = await repo().returnToPending(original.id, original.revision);
  const changed = await repo().updateQueueItem(pending.id, { cardId: 'changed-card' }, pending.revision);
  const { separated } = await repo().splitQueueItem(changed.id, 'changed-child', 3000, changed.revision);
  await env.DB.exec("UPDATE cards SET name = 'Later name' WHERE id = 'changed-card'");
  const child = await repo().confirmQueueItem(separated.id, 'approved-child', { ...input, id: 'approved-child', cardId: 'changed-card', amountCents: 3000 }, separated.revision);
  expect(child.cardNameSnapshot).toBe('At split');
});
it('rejects a legacy approval that cannot preserve a returned split child financial baseline', async () => {
  const original = await repo().insertTransaction({ ...input, splitType: 'equal', splitRule: null });
  const pending = await repo().returnToPending(original.id, original.revision);
  const { separated } = await repo().splitQueueItem(pending.id, 'returned-child', 3000, pending.revision);
  await db().insert(householdMembers).values({ id: 'm3', householdId: 'h1', displayName: 'New', createdAt: 0 });
  const history = await repo().expenseHistory(separated.expenseId);
  const oldApproval = env.DB.batch([
    env.DB.prepare("INSERT INTO expense_history (id, household_id, expense_id, revision, event_type, timestamp, before_json, after_json) VALUES ('old-approval', 'h1', ?, 2, 'approved', 999, ?, ?)")
      .bind(separated.expenseId, JSON.stringify({ ...separated, state: 'pending' }), JSON.stringify({ ...separated, state: 'approved', revision: 2 })),
    env.DB.prepare(`INSERT INTO transactions (id, household_id, expense_id, revision, date, store, amount_cents, category, payer_id, split_type, split_rule_json, split_shares_json, created_at, updated_at)
      SELECT 'old-approved', household_id, expense_id, revision + 1, date, store, amount_cents, category, payer_id, split_type, split_rule_json, '{"m1":1000,"m2":1000,"m3":1000}', created_at, 999 FROM queue_items WHERE id = 'returned-child'`),
    env.DB.prepare("DELETE FROM queue_items WHERE id = 'returned-child'"),
  ]);
  await expect(oldApproval).rejects.toThrow('current application version');
  expect(await repo().expenseHistory(separated.expenseId)).toEqual(history);
  expect((await repo().queueItems()).find(row => row.id === separated.id)).toEqual(separated);
  expect(await repo().activeTransactions()).toEqual([]);
  const approved = await repo().confirmQueueItem(separated.id, 'new-approved', { ...input, id: 'new-approved', amountCents: 3000, splitType: 'equal', splitRule: null }, separated.revision);
  expect(JSON.parse(approved.splitSharesJson)).toEqual({ m1: 1500, m2: 1500 });
});
const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;
let cookie: string;
const request = (path: string, body: unknown, method = 'PATCH') => app.request(`http://localhost/api/${path}`, {
  method, headers: { Cookie: cookie, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}, testEnv);
const changedFields = (values: Record<string, unknown> | null) => Object.keys(values ?? {})
  .filter(key => !['id', 'expenseId', 'revision', 'state', 'updatedAt', 'reviewNote'].includes(key)).sort();

beforeEach(async () => {
  for (const trigger of ['fail_pending_split', 'fail_pending_preference']) await env.DB.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const table of ['transactions', 'queue_items', 'cycles', 'category_preferences', 'cards', 'household_members', 'households', 'session', 'user']) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await db().insert(households).values([{ id: 'h1', name: 'Ours', createdAt: 0 }, { id: 'h2', name: 'Theirs', createdAt: 0 }]);
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', userId: 'u1', createdAt: 0 },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0 },
    { id: 'x1', householdId: 'h2', displayName: 'Other', createdAt: 0 },
  ]);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
    .bind('u1', 'Sam', 'owner@example.com', now, now).run();
  const ctx = await createAuth(testEnv).$context;
  const session = await ctx.internalAdapter.createSession('u1');
  cookie = (await serializeSignedCookie(ctx.authCookies.sessionToken.name, session.token, ctx.secret)).split(';')[0];
});

const split = (row: { id: string; revision: number }, amountCents = 3000, queueItemId = 'q-child') =>
  request(`queue/${row.id}/split`, { revision: row.revision, amountCents, queueItemId }, 'POST');

describe('atomic Pending transaction breakdown', () => {
  it('bounds ancestor history at the source revision saved by the breakdown', async () => {
    const approved = await repo().insertTransaction(input);
    const returned = await repo().returnToPending(approved.id, approved.revision);
    const response = await split(returned);
    expect(response.status).toBe(200);
    const { original, separated } = await response.json() as any;
    await repo('m2').updateQueueItem(original.id, { category: 'Dining' }, original.revision);
    const history = await repo().expenseHistory(separated.expenseId);
    expect(history.filter(event => event.expenseId === original.expenseId && event.after.revision > original.revision)).toEqual([]);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ expenseId: approved.expenseId, eventType: 'returned_to_pending' }),
    ]));
  });
  it('reads history rows in proportion to the lineage, not the household history', async () => {
    const row = await repo().insertTransaction(input);
    const { separated } = await repo().splitTransaction(row.id, 'approved-child', 3000, row.revision);
    await env.DB.prepare(`INSERT INTO expense_history (id, household_id, expense_id, revision, event_type, timestamp, after_json, source_row_id, target_row_id)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
      SELECT 'noise-' || i, 'h1', 'noise-expense-' || i, 1, 'edited', 0, json_object('id', 'noise-row-' || i), 'noise-source', 'noise-target-' || i FROM n`).run();
    const queries: { sql: string; params: unknown[] }[] = [];
    const logged = new ScopedRepository(drizzle(env.DB, { logger: { logQuery: (sql, params) => queries.push({ sql, params }) } }), 'h1', { memberId: 'm1', displayName: 'Sam' });
    expect(await logged.expenseHistory(separated.expenseId)).toEqual(await repo().expenseHistory(separated.expenseId));
    const [query] = queries;
    const { meta } = await env.DB.prepare(query.sql).bind(...query.params).all();
    expect(meta.rows_read).toBeLessThan(100);
  });
  it('marks meaningful Approved breakdowns and keeps their child lineage', async () => {
    const row = await repo().insertTransaction(input);
    const result = await repo().splitTransaction(row.id, 'approved-child', 3000, row.revision);
    expect((result.original as any).lastEditedAt).toBeGreaterThan(0);
    expect(result.separated).toMatchObject({ hasBeenApproved: true, parentExpenseId: row.expenseId });
    expect(await repo().expenseHistory(result.separated.expenseId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ expenseId: row.expenseId, eventType: 'edited' }),
    ]));
  });
  it.each([10000, -10000])('conserves signed total %s, provenance and first-time history on identical retry', async amountCents => {
    const row = await repo().insertQueueItem({ ...pendingInput, amountCents });
    const response = await split(row, Math.sign(amountCents) * 3000);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.original).toMatchObject({ amountCents: Math.sign(amountCents) * 7000, revision: 2, hasBeenApproved: false, lastEditedAt: null });
    expect(result.separated).toMatchObject({ id: 'q-child', amountCents: Math.sign(amountCents) * 3000, revision: 1,
      hasBeenApproved: false, lastEditedAt: null, parentExpenseId: row.expenseId,
      source: 'csv', sourceFileId: 'upload-1', sourceFileName: 'statement.csv', splitRuleJson: row.splitRuleJson });
    expect(result.separated.expenseId).not.toBe(row.expenseId);
    expect((await split(row, Math.sign(amountCents) * 3000)).status).toBe(200);
    expect((await repo().queueItems()).reduce((sum, entry) => sum + entry.amountCents!, 0)).toBe(amountCents);
    expect(await repo().queueItems()).toHaveLength(2);
    expect(await repo().activeTransactions()).toEqual([]);
    expect((await repo().expenseHistory(row.expenseId)).filter(event => event.eventType === 'edited')).toEqual([]);
  });

  it('rolls back source amount, child and history when creation fails, then retries once', async () => {
    const row = await repo().insertQueueItem(pendingInput);
    await env.DB.exec("CREATE TRIGGER fail_pending_split BEFORE INSERT ON queue_items WHEN NEW.id = 'q-child' BEGIN SELECT RAISE(ABORT, 'forced child failure'); END");
    const response = await split(row);
    expect(response.status).toBe(500);
    expect(await repo().queueItems()).toEqual([row]);
    expect(await repo().expenseHistory(row.expenseId)).toHaveLength(1);
    await env.DB.exec('DROP TRIGGER fail_pending_split');
    expect((await split(row)).status).toBe(200);
    expect((await split(row)).status).toBe(200);
    expect(await repo().queueItems()).toHaveLength(2);
  });

  it('rejects invalid portions and incomplete source amounts without changing money', async () => {
    const row = await repo().insertQueueItem(pendingInput);
    for (const amount of [0, 10000, 10001, -3000, 0.5, 100000001]) expect((await split(row, amount)).status).toBe(400);
    expect((await request(`queue/${row.id}/split`, { amountCents: 3000, queueItemId: 'q-child' }, 'POST')).status).toBe(400);
    expect((await request(`queue/${row.id}/split`, { revision: 1, amountCents: 3000, queueItemId: '' }, 'POST')).status).toBe(400);
    expect(await repo().queueItems()).toEqual([row]);
    const blank = await repo().insertQueueItem({ ...pendingInput, id: 'blank', amountCents: null });
    expect((await split(blank)).status).toBe(400);
    expect((await repo().queueItems()).find(entry => entry.id === blank.id)?.amountCents).toBeNull();
  });

  it('rejects stale originals, altered retries and retries after later child changes', async () => {
    const row = await repo().insertQueueItem(pendingInput);
    const changed = await repo().updateQueueItem(row.id, { store: 'Saved merchant' }, row.revision);
    expect((await split(row)).status).toBe(409);
    expect((await split(changed)).status).toBe(200);
    expect((await split(changed, 2000)).status).toBe(409);
    await repo().updateQueueItem('q-child', { category: 'Dining' }, 1);
    expect((await split(changed)).status).toBe(409);
    expect((await repo().queueItems()).reduce((sum, entry) => sum + entry.amountCents!, 0)).toBe(10000);
  });

  it('rejects foreign originals and foreign child collisions', async () => {
    const foreign = new ScopedRepository(db(), 'h2');
    const foreignRow = await foreign.insertQueueItem({ ...pendingInput, id: 'q-child', payerId: 'x1', splitType: 'equal', splitRule: null });
    expect((await split(foreignRow, 3000, 'foreign-new')).status).toBe(404);
    const row = await repo().insertQueueItem(pendingInput);
    expect((await split(row)).status).toBe(409);
    expect(await repo().queueItems()).toEqual([row]);
    expect(await foreign.queueItems()).toEqual([foreignRow]);
  });

  it('rejects a child identity already used by an Approved expense', async () => {
    const row = await repo().insertQueueItem(pendingInput);
    const existing = await repo().insertTransaction({ ...input, id: 'q-child' });
    expect((await split(row)).status).toBe(409);
    expect(await repo().queueItems()).toEqual([row]);
    expect(await repo().activeTransactions()).toEqual([existing]);
  });

  it('allows one concurrent breakdown and never duplicates or partially reduces the original', async () => {
    const row = await repo().insertQueueItem(pendingInput);
    const responses = await Promise.all(['q-a', 'q-b'].map(id => split(row, 3000, id)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await repo().queueItems()).toHaveLength(2);
    expect((await repo().queueItems()).reduce((sum, entry) => sum + entry.amountCents!, 0)).toBe(10000);
    expect(await repo().expenseHistory(row.expenseId)).toHaveLength(2);
  });

  it('retains real prior approval lineage and freezes child reapproval before later parent changes', async () => {
    const equal = { ...input, splitType: 'equal' as const, splitRule: null };
    const first = await repo().insertQueueItem({ ...pendingInput, splitType: 'equal', splitRule: null });
    const approved = await repo().confirmQueueItem(first.id, 't1', equal, first.revision);
    const edited = await repo('m2').updateTransaction(approved.id, { store: 'Reviewed' }, approved.revision);
    const returned = await repo().returnToPending(edited.id, edited.revision, 'Check amounts');
    await db().insert(householdMembers).values({ id: 'm3', householdId: 'h1', displayName: 'New member', createdAt: 0 });
    const response = await split(returned);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.original).toMatchObject({ amountCents: 7000, hasBeenApproved: true });
    expect(result.separated).toMatchObject({ amountCents: 3000, hasBeenApproved: true, parentExpenseId: first.expenseId, reviewNote: 'Check amounts' });
    expect(result.original.lastEditedAt).toBeGreaterThan(0);
    expect(result.separated.lastEditedAt).toBeGreaterThan(0);
    const history = await repo().expenseHistory(result.separated.expenseId);
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ expenseId: first.expenseId, eventType: 'approved', actorName: 'Sam' }),
      expect.objectContaining({ expenseId: first.expenseId, eventType: 'edited', actorName: 'Hugo' })]));
    expect(history.filter(event => event.expenseId === result.separated.expenseId && event.eventType === 'approved')).toEqual([]);
    const parentChanged = await repo().updateQueueItem(result.original.id, { splitType: 'single', splitRule: { memberId: 'm2' } }, result.original.revision);
    const parentApproved = await repo().confirmQueueItem(parentChanged.id, 'parent-again', { ...equal, id: 'parent-again', store: 'Reviewed', amountCents: 7000,
      splitType: 'single', splitRule: { memberId: 'm2' } }, parentChanged.revision);
    await repo().returnToPending(parentApproved.id, parentApproved.revision);
    const child = await repo().confirmQueueItem(result.separated.id, 'child-approved', { ...equal, id: 'child-approved', store: 'Reviewed', amountCents: 3000 }, result.separated.revision);
    expect(child).toMatchObject({ hasBeenApproved: true, parentExpenseId: first.expenseId });
    expect(JSON.parse(child.splitSharesJson)).toEqual({ m1: 1500, m2: 1500 });
  });

  it('retains nested lineage and frozen participants after Pending children are split again', async () => {
    const original = await repo().insertTransaction({ ...input, splitType: 'equal', splitRule: null });
    const returned = await repo().returnToPending(original.id, original.revision);
    const first = await (await split(returned)).json() as any;
    expect(first.separated).toHaveProperty('id', 'q-child');
    const secondResponse = await split(first.separated, 1000, 'q-grandchild');
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as any;
    expect(second.separated).toMatchObject({ hasBeenApproved: true, parentExpenseId: first.separated.expenseId });
    expect(await repo().expenseHistory(second.separated.expenseId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ expenseId: original.expenseId, eventType: 'returned_to_pending' }),
    ]));
    await db().insert(householdMembers).values({ id: 'm3', householdId: 'h1', displayName: 'New', createdAt: 0 });
    const grandchild = await repo().confirmQueueItem(second.separated.id, 'grandchild-approved', { ...input, id: 'grandchild-approved', amountCents: 1000, splitType: 'equal', splitRule: null }, second.separated.revision);
    expect(JSON.parse(grandchild.splitSharesJson)).toEqual({ m1: 500, m2: 500 });
  });

  it('keeps lineage readable after atomic bulk deletion of Pending parent and child', async () => {
    const row = await repo().insertQueueItem(pendingInput);
    const response = await split(row);
    expect(response.status).toBe(200);
    const { original, separated } = await response.json() as any;
    await repo().deleteQueueItems([original.id, separated.id], { [original.id]: original.revision, [separated.id]: separated.revision });
    expect(await repo().queueItems()).toEqual([]);
    expect(await repo().expenseHistory(separated.expenseId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ expenseId: row.expenseId, eventType: 'split' }),
      expect.objectContaining({ expenseId: separated.expenseId, eventType: 'deleted' }),
    ]));
  });
});

describe('approval-aware Pending persistence', () => {
  it('persists first-time nullable Pending edits without edit-history entries', async () => {
    const row = await repo().insertQueueItem({ ...pendingInput, amountCents: null });
    expect(row).toMatchObject({ hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null });
    const saved = await repo().updateQueueItem(row.id, { store: 'Completed merchant' }, row.revision);
    const reloaded = (await new ScopedRepository(db(), 'h1').queueItems())[0];
    expect(reloaded).toMatchObject({ store: 'Completed merchant', amountCents: null,
      hasBeenApproved: false, lastEditedAt: null, revision: saved.revision });
    expect((await repo().expenseHistory(row.expenseId)).filter(event => event.eventType === 'edited')).toEqual([]);
  });

  it('keeps approval monotonic and records only later changed fields with the real actor', async () => {
    const row = await repo().insertQueueItem(pendingInput);
    const tx = await repo().confirmQueueItem(row.id, input.id, input, row.revision);
    expect(tx).toMatchObject({ hasBeenApproved: true, lastEditedAt: null });
    const returned = await repo('m2').returnToPending(tx.id, tx.revision, 'Check merchant');
    expect(returned).toMatchObject({ hasBeenApproved: true, lastEditedAt: null });
    const saved = await repo().updateQueueItem(returned.id, { store: 'Corrected merchant' }, returned.revision);
    expect(saved).toMatchObject({ hasBeenApproved: true, editedByName: 'Sam' });
    expect((saved as any).lastEditedAt).toBeGreaterThan(0);
    const edit = (await repo().expenseHistory(row.expenseId)).find(event => event.eventType === 'edited')!;
    expect(edit).toMatchObject({ actorMemberId: 'm1', actorName: 'Sam', before: { store: 'Market' }, after: { store: 'Corrected merchant' } });
    expect(changedFields(edit.before)).toEqual(['store']);
    expect(changedFields(edit.after)).toEqual(['store']);
    const approved = await repo('m2').confirmQueueItem(saved.id, 't2', { ...input, id: 't2', store: 'Corrected merchant' }, saved.revision);
    expect(approved).toMatchObject({ hasBeenApproved: true, editedByName: 'Sam', lastEditedAt: (saved as any).lastEditedAt });
  });

  it.each(['pending', 'approved'])('ignores no-op %s writes without changing revision, preferences or history', async stage => {
    const row = stage === 'pending' ? await repo().insertQueueItem(pendingInput) : await repo().insertTransaction(input);
    const before = await repo().expenseHistory(row.expenseId);
    const saved = stage === 'pending'
      ? await repo('m2').updateQueueItem(row.id, { store: 'Market', category: 'Groceries', splitRule: { percentages: { m2: 30, m1: 70 } } }, row.revision)
      : await repo('m2').updateTransaction(row.id, { store: 'Market', category: 'Groceries', splitRule: { percentages: { m2: 30, m1: 70 } } }, row.revision);
    expect(saved).toEqual(row);
    expect(await repo().expenseHistory(row.expenseId)).toEqual(before);
    expect(await repo().categoryPreferences()).toEqual({});
  });

  it('stores compact Approved changes, ignores forged lifecycle markers, and keeps source values', async () => {
    const row = await repo().insertTransaction(input);
    const response = await request(`transactions/${row.id}`, { revision: row.revision, amountCents: 7000,
      hasBeenApproved: false, lastEditedAt: 1, parentExpenseId: 'foreign', actorName: 'Forged' });
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved).toMatchObject({ amountCents: 7000, hasBeenApproved: true, parentExpenseId: null, editedByName: 'Sam' });
    const event = (await repo().expenseHistory(row.expenseId))[0];
    expect(changedFields(event.before)).toEqual(['amountCents', 'splitSharesJson']);
    expect(changedFields(event.after)).toEqual(['amountCents', 'splitSharesJson']);
    expect(event.before?.amountCents).toBe(10000);
    expect(event.after.amountCents).toBe(7000);
    expect(JSON.parse(event.after.splitSharesJson as string)).toEqual({ m1: 4900, m2: 2100 });
    expect(saved).toMatchObject({ source: row.source, sourceFileId: row.sourceFileId });
  });

  it('retains last edit actor and time when another member closes the cycle', async () => {
    const row = await repo().insertTransaction(input);
    const saved = await repo().updateTransaction(row.id, { store: 'Corrected' }, row.revision);
    await repo('m2').closeCycle('cy1', [row.id], { [row.id]: saved.revision });
    const closed = (await repo().transactionsByCycle('cy1'))[0];
    expect(closed).toMatchObject({ editedByName: 'Sam', lastEditedAt: (saved as any).lastEditedAt, hasBeenApproved: true });
    expect((await repo().expenseHistory(row.expenseId))[0]).toMatchObject({ eventType: 'closed', actorName: 'Hugo' });
  });

  it('records bulk category suggestions as compact edits', async () => {
    const row = await repo().insertTransaction({ ...input, category: 'Other' });
    expect(await repo().applyCategorySuggestions([{ id: row.id, category: 'Dining', revision: row.revision }])).toEqual({ applied: [row.id], skipped: [] });
    const event = (await repo().expenseHistory(row.expenseId))[0];
    expect(changedFields(event.before)).toEqual(['category']);
    expect(changedFields(event.after)).toEqual(['category']);
    expect((await repo().activeTransactions())[0]).toMatchObject({ editedByName: 'Sam' });
    expect((await repo().activeTransactions())[0]).toHaveProperty('lastEditedAt', event.timestamp);
  });

  it('allows only one concurrent initial Pending edit without adding ordinary history', async () => {
    const row = await repo().insertQueueItem(pendingInput);
    const responses = await Promise.all(['First', 'Second'].map(store => request(`queue/${row.id}`, { revision: row.revision, store })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await repo().queueItems())[0].revision).toBe(row.revision + 1);
    expect(await repo().expenseHistory(row.expenseId)).toHaveLength(1);
  });

  it('rolls back first Pending edits and preferences together on failure', async () => {
    const row = await repo().insertQueueItem(pendingInput);
    await env.DB.exec("CREATE TRIGGER fail_pending_preference BEFORE INSERT ON category_preferences BEGIN SELECT RAISE(ABORT, 'forced preference failure'); END");
    await expect(repo().updateQueueItem(row.id, { category: 'Dining' }, row.revision)).rejects.toThrow(/forced preference failure/);
    expect((await repo().queueItems())[0]).toEqual(row);
    expect(await repo().expenseHistory(row.expenseId)).toHaveLength(1);
    expect(await repo().categoryPreferences()).toEqual({});
  });
});
