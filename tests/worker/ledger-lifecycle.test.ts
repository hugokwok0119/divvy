import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, type D1Migration } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { serializeSignedCookie } from 'better-call';
import { households, householdMembers, cards } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';
import { createAuth } from '../../worker/auth';
import app, { type Env } from '../../worker/index';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1', { memberId: 'm1', displayName: 'Sam' });
const txInput = { id: 't1', date: '2026-10-13', store: 'Market', amountCents: 10000,
  category: 'Groceries', payerId: 'm1', cardId: null, splitType: 'custom' as const,
  splitRule: { percentages: { m1: 70, m2: 30 } } };
const queueInput = { ...txInput, id: 'q1', source: 'csv' as const,
  sourceFileId: 'upload-1', sourceFileName: 'statement.csv' };
const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;
let cookie: string;
const request = (path: string, method = 'GET', body?: unknown) => app.request(`http://localhost/api/${path}`, {
  method, headers: { Cookie: cookie, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}, testEnv);

beforeEach(async () => {
  await env.DB.exec('DROP TRIGGER IF EXISTS fail_approval');
  await env.DB.exec('DROP TRIGGER IF EXISTS fail_preference');
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

describe('collaborative expense lifecycle', () => {
  it('persists custom Pending allocation and source context across approval, return and reapproval', async () => {
    const pending = await repo().insertQueueItem(queueInput);
    expect(pending.splitRuleJson).toBe(JSON.stringify(txInput.splitRule));
    const approved = await repo().confirmQueueItem('q1', 't1', txInput, pending.revision);
    expect(approved.expenseId).toBe(pending.expenseId);
    expect(JSON.parse(approved.splitSharesJson)).toEqual({ m1: 7000, m2: 3000 });
    const returned = await repo().returnToPending('t1', approved.revision, 'Check allocation');
    expect(returned).toMatchObject({ expenseId: pending.expenseId, source: 'csv', sourceFileId: 'upload-1',
      sourceFileName: 'statement.csv', splitRuleJson: pending.splitRuleJson, reviewNote: 'Check allocation' });
    expect(await repo().activeTransactions()).toEqual([]);
    expect(await repo().queueItems()).toHaveLength(1);
    const again = await repo().confirmQueueItem(returned.id, 't2', { ...txInput, id: 't2' }, returned.revision);
    expect(again.expenseId).toBe(pending.expenseId);
    expect(await repo().queueItems()).toEqual([]);
    expect(await repo().activeTransactions()).toHaveLength(1);
    expect((await repo().expenseHistory(pending.expenseId)).map((e) => e.eventType)).toEqual(['approved', 'returned_to_pending', 'approved', 'imported']);
  });

  it('returns the same target on repeated transitions without extra history', async () => {
    const q = await repo().insertQueueItem(queueInput);
    const tx = await repo().confirmQueueItem(q.id, 't1', txInput, q.revision);
    expect(await repo().confirmQueueItem(q.id, 't1', txInput, q.revision)).toEqual(tx);
    const pending = await repo().returnToPending(tx.id, tx.revision);
    expect(await repo().returnToPending(tx.id, tx.revision)).toEqual(pending);
    expect(await repo().expenseHistory(q.expenseId)).toHaveLength(3);
  });

  it('rejects approval retries after another saved edit or return instead of resurrecting work', async () => {
    const q = await repo().insertQueueItem(queueInput);
    const tx = await repo().confirmQueueItem(q.id, 't1', txInput, q.revision);
    const edited = await repo().updateTransaction(tx.id, { store: 'Changed' }, tx.revision);
    await expect(repo().confirmQueueItem(q.id, 't1', txInput, q.revision)).rejects.toMatchObject({ status: 409 });
    await repo().returnToPending(edited.id, edited.revision);
    await expect(repo().confirmQueueItem(q.id, 't1', txInput, q.revision)).rejects.toMatchObject({ status: 409 });
    expect(await repo().activeTransactions()).toEqual([]);
  });

  it('records exact saved before/after values and authenticated actor, ignoring client identity', async () => {
    const tx = await repo().insertTransaction(txInput);
    const response = await request(`transactions/${tx.id}`, 'PATCH', { revision: tx.revision, store: 'Updated', actorMemberId: 'x1', actorName: 'Forged' });
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated).toMatchObject({ revision: tx.revision + 1, editedByMemberId: 'm1', editedByName: 'Sam', cycleId: null });
    const events = await (await request(`transactions/history/${tx.expenseId}`)).json() as Array<Record<string, unknown>>;
    expect(events[0]).toMatchObject({ eventType: 'edited', actorMemberId: 'm1', actorName: 'Sam',
      before: { store: 'Market' }, after: { store: 'Updated' } });
    expect(JSON.stringify(events)).not.toContain('u1');
  });

  it('rejects missing versions and stale HTTP writes without changing fields, preferences or history', async () => {
    const tx = await repo().insertTransaction(txInput);
    expect((await request(`transactions/${tx.id}`, 'PATCH', { store: 'Missing revision' })).status).toBe(400);
    await repo().updateTransaction(tx.id, { store: 'Saved' }, tx.revision);
    const before = await repo().expenseHistory(tx.expenseId);
    expect((await request(`transactions/${tx.id}`, 'PATCH', { revision: tx.revision, category: 'Dining', store: 'Stale' })).status).toBe(409);
    expect((await repo().activeTransactions())[0].store).toBe('Saved');
    expect(await repo().expenseHistory(tx.expenseId)).toEqual(before);
    expect(await repo().categoryPreferences()).toEqual({});
  });

  it('allows one simultaneous save and rejects the losing revision with no false history', async () => {
    const tx = await repo().insertTransaction(txInput);
    const responses = await Promise.all(['First', 'Second'].map((store) => request(`transactions/${tx.id}`, 'PATCH', { revision: tx.revision, store })));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await repo().expenseHistory(tx.expenseId)).toHaveLength(2);
    expect((await repo().activeTransactions())[0].revision).toBe(tx.revision + 1);
  });

  it('rolls back transition and history together when target insert fails', async () => {
    const q = await repo().insertQueueItem(queueInput);
    await env.DB.exec("CREATE TRIGGER fail_approval BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'forced approval failure'); END");
    await expect(repo().confirmQueueItem(q.id, 't1', txInput, q.revision)).rejects.toThrow(/forced approval failure/);
    expect(await repo().queueItems()).toHaveLength(1);
    expect(await repo().activeTransactions()).toEqual([]);
    expect(await repo().expenseHistory(q.expenseId)).toHaveLength(1);
    await env.DB.exec('DROP TRIGGER fail_approval');
  });

  it('rolls back saved values and history together when category preference write fails', async () => {
    const tx = await repo().insertTransaction(txInput);
    await env.DB.exec("CREATE TRIGGER fail_preference BEFORE INSERT ON category_preferences BEGIN SELECT RAISE(ABORT, 'forced preference failure'); END");
    await expect(repo().updateTransaction(tx.id, { category: 'Dining' }, tx.revision)).rejects.toThrow(/forced preference failure/);
    expect((await repo().activeTransactions())[0]).toEqual(tx);
    expect(await repo().expenseHistory(tx.expenseId)).toHaveLength(1);
    await env.DB.exec('DROP TRIGGER fail_preference');
  });

  it('denies cross-household writes and history reads, including deleted history', async () => {
    const tx = await new ScopedRepository(db(), 'h2').insertTransaction({ ...txInput, payerId: 'x1', splitType: 'equal', splitRule: null });
    expect((await request(`transactions/${tx.id}`, 'PATCH', { revision: tx.revision, store: 'Hijacked' })).status).toBe(404);
    expect((await request(`transactions/history/${tx.expenseId}`)).status).toBe(404);
    await new ScopedRepository(db(), 'h2').softDeleteTransaction(tx.id, tx.revision);
    expect((await request(`transactions/history/${tx.expenseId}`)).status).toBe(404);
  });

  it('keeps deletion history readable in the household and includes all events in backups', async () => {
    const tx = await repo().insertTransaction(txInput);
    await repo().softDeleteTransaction(tx.id, tx.revision);
    const events = await repo().expenseHistory(tx.expenseId);
    expect(events[0]).toMatchObject({ eventType: 'deleted', before: { store: 'Market' }, after: { state: 'deleted' } });
    expect(await repo().activeTransactions()).toEqual([]);
    expect((await repo().exportAll()).expenseHistory).toHaveLength(2);
  });

  it('rejects settled edits and return, and rejects return from a closed unsettled cycle', async () => {
    const tx = await repo().insertTransaction(txInput);
    await repo().closeCycle('cy1', [tx.id], { [tx.id]: tx.revision });
    await expect(repo().returnToPending(tx.id, tx.revision)).rejects.toMatchObject({ status: 409 });
    await repo().settleCycle('cy1');
    await expect(repo().updateTransaction(tx.id, { amountCents: 999 }, tx.revision)).rejects.toMatchObject({ status: 409 });
    await expect(repo().returnToPending(tx.id, tx.revision)).rejects.toMatchObject({ status: 409 });
  });

  it('preserves transaction-only snapshots through return and unrelated edits, rebuilding only changed allocation/card values', async () => {
    await db().insert(cards).values({ id: 'c1', householdId: 'h1', memberId: 'm1', name: 'Original card' });
    const input = { ...txInput, splitType: 'equal' as const, splitRule: null, cardId: 'c1', isStarred: true, favoriteName: 'Saved expense' };
    const tx = await repo().insertTransaction(input);
    const q = await repo().returnToPending(tx.id, tx.revision);
    await db().insert(householdMembers).values({ id: 'm3', householdId: 'h1', displayName: 'New', createdAt: 0 });
    await env.DB.exec("UPDATE cards SET name = 'Renamed card' WHERE id = 'c1'");
    const edited = await repo().updateQueueItem(q.id, { store: 'New merchant', amountCents: 12000 }, q.revision);
    const approved = await repo().confirmQueueItem(q.id, 't2', { ...input, id: 't2', store: 'New merchant', amountCents: 12000, isStarred: undefined, favoriteName: undefined }, edited.revision);
    expect(approved).toMatchObject({ cardNameSnapshot: 'Original card', isStarred: 1, favoriteName: 'Saved expense' });
    expect(JSON.parse(approved.splitSharesJson)).toEqual({ m1: 6000, m2: 6000 });
    const returned = await repo().returnToPending(approved.id, approved.revision);
    const changed = await repo().updateQueueItem(returned.id, { splitType: 'custom', splitRule: { percentages: { m1: 25, m2: 25, m3: 50 } }, cardId: null }, returned.revision);
    const again = await repo().confirmQueueItem(changed.id, 't3', { ...input, id: 't3', amountCents: 12000, splitType: 'custom', splitRule: { percentages: { m1: 25, m2: 25, m3: 50 } }, cardId: null }, changed.revision);
    expect(JSON.parse(again.splitSharesJson)).toEqual({ m1: 3000, m2: 3000, m3: 6000 });
    expect(again.cardNameSnapshot).toBeNull();
  });

  it('does not resurrect an uploaded Pending row when the same import retries after approval', async () => {
    const result = await repo().insertQueueItemsBulk([queueInput]);
    await repo().confirmQueueItem(queueInput.id, 't1', txInput, result.created[0].revision);
    const retry = await repo().insertQueueItemsBulk([queueInput]);
    expect(retry).toMatchObject({ created: [], inserted: 0, rejected: 1 });
    expect(await repo().queueItems()).toEqual([]);
    expect(await repo().activeTransactions()).toHaveLength(1);
  });

  it('rolls back whole bulk import and initial history if a later row fails', async () => {
    await env.DB.exec("CREATE TRIGGER fail_approval BEFORE INSERT ON transactions WHEN NEW.id = 't2' BEGIN SELECT RAISE(ABORT, 'forced bulk failure'); END");
    await expect(repo().insertTransactionsBulk([txInput, { ...txInput, id: 't2' }])).rejects.toThrow(/forced bulk failure/);
    expect(await repo().activeTransactions()).toEqual([]);
    expect((await repo().exportAll()).expenseHistory).toEqual([]);
  });

  it('rejects a stale bulk deletion without deleting any selection or saving false history', async () => {
    const result = await repo().insertQueueItemsBulk([queueInput, { ...queueInput, id: 'q2' }]);
    const first = result.created[0];
    await repo().updateQueueItem(first.id, { store: 'Changed' }, first.revision);
    const before = (await repo().exportAll()).expenseHistory;
    const response = await request('queue/delete-bulk', 'POST', { ids: ['q1', 'q2'], revisions: { q1: 1, q2: 1 } });
    expect(response.status).toBe(409);
    expect(await repo().queueItems()).toHaveLength(2);
    expect((await repo().exportAll()).expenseHistory).toEqual(before);
  });

  it('records accepted suggestions with actor and skips stale versions without false history', async () => {
    const tx = await repo().insertTransaction({ ...txInput, category: 'Other' });
    const updated = await repo().updateTransaction(tx.id, { store: 'Changed' }, tx.revision);
    expect(await repo().applyCategorySuggestions([{ id: tx.id, category: 'Dining', revision: tx.revision }])).toEqual({ applied: [], skipped: ['t1'] });
    expect(await repo().applyCategorySuggestions([{ id: tx.id, category: 'Dining', revision: updated.revision }])).toEqual({ applied: ['t1'], skipped: [] });
    const events = await repo().expenseHistory(tx.expenseId);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ eventType: 'category_suggestion', actorMemberId: 'm1', before: { category: 'Other' }, after: { category: 'Dining' } });
  });

  it('reports actual partial queue acceptance when a competing import is approved before its batch', async () => {
    const targetDb = db();
    const targetRepo = new ScopedRepository(targetDb, 'h1');
    const runBatch = targetDb.batch.bind(targetDb);
    vi.spyOn(targetDb, 'batch').mockImplementationOnce(async (statements) => {
      const concurrent = await repo().insertQueueItem(queueInput);
      await repo().confirmQueueItem(concurrent.id, 'concurrent-t1', { ...txInput, id: 'concurrent-t1' }, concurrent.revision);
      const results = await runBatch(statements);
      // A newly accepted row can also move before the HTTP response; the saved result remains valid.
      const second = (await repo().queueItems()).find((q) => q.id === 'q2')!;
      await repo().confirmQueueItem(second.id, 'concurrent-t2', { ...txInput, id: 'concurrent-t2' }, second.revision);
      return results;
    });
    const result = await targetRepo.insertQueueItemsBulk([queueInput, { ...queueInput, id: 'q2' }]);
    expect(result).toMatchObject({ inserted: 1, rejected: 1, duplicate: 1, created: [{ id: 'q2' }] });
    expect(await repo().queueItems()).toEqual([]);
    expect(await repo().activeTransactions()).toHaveLength(2);
  });

  it('does not count a concurrently created Pending row as another accepted import', async () => {
    const targetDb = db();
    const targetRepo = new ScopedRepository(targetDb, 'h1');
    const runBatch = targetDb.batch.bind(targetDb);
    vi.spyOn(targetDb, 'batch').mockImplementationOnce(async (statements) => {
      await repo().insertQueueItem(queueInput);
      return runBatch(statements);
    });
    const result = await targetRepo.insertQueueItemsBulk([queueInput, { ...queueInput, id: 'q2' }]);
    expect(result).toMatchObject({ inserted: 1, rejected: 1, created: [{ id: 'q2' }] });
    expect(await repo().queueItems()).toHaveLength(2);
  });

  it.each([false, true])('rejects changed transaction selection before its batch, all-existing retry: %s', async (allExisting) => {
    const existing = await repo().insertTransaction(txInput);
    const targetDb = db();
    const targetRepo = new ScopedRepository(targetDb, 'h1');
    const runBatch = targetDb.batch.bind(targetDb);
    vi.spyOn(targetDb, 'batch').mockImplementationOnce(async (statements) => {
      await repo().returnToPending(existing.id, existing.revision);
      return runBatch(statements);
    });
    await expect(targetRepo.insertTransactionsBulk(allExisting ? [txInput] : [txInput, { ...txInput, id: 't2' }])).rejects.toMatchObject({ status: 409 });
    expect(await repo().activeTransactions()).toEqual([]);
    expect(await repo().queueItems()).toHaveLength(1);
    expect((await repo().exportAll()).expenseHistory).toHaveLength(2);
  });

  it('retains the saved review note on a second return unless explicitly cleared', async () => {
    const original = await repo().insertTransaction(txInput);
    const pending = await repo().returnToPending(original.id, original.revision, 'Check allocation');
    const approved = await repo().confirmQueueItem(pending.id, 't2', { ...txInput, id: 't2' }, pending.revision);
    const returned = await repo().returnToPending(approved.id, approved.revision);
    expect(returned.reviewNote).toBe('Check allocation');
    expect((await repo().expenseHistory(returned.expenseId))[0].reviewNote).toBe('Check allocation');
    const again = await repo().confirmQueueItem(returned.id, 't3', { ...txInput, id: 't3' }, returned.revision);
    const cleared = await repo().returnToPending(again.id, again.revision, '');
    expect(cleared.reviewNote).toBeNull();
    expect((await repo().expenseHistory(cleared.expenseId))[0].reviewNote).toBeNull();
  });

  it('keeps one counted expense through the full confirmed closing and correction lifecycle', async () => {
    const importedResponse = await request('queue', 'POST', queueInput);
    expect(importedResponse.status).toBe(201);
    const imported = await importedResponse.json() as { id: string; expenseId: string; revision: number };
    const left = await repo().insertQueueItem({ ...queueInput, id: 'left-pending', store: 'For later' });
    const savedResponse = await request(`queue/${imported.id}`, 'PATCH', { revision: imported.revision, splitType: 'custom', splitRule: { percentages: { m1: 70, m2: 30 } } });
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json() as { revision: number };
    const approval = await request(`queue/${imported.id}/confirm`, 'POST', { transactionId: 't1', revision: saved.revision, transaction: txInput });
    expect(approval.status).toBe(201);
    const approved = await approval.json() as { id: string; revision: number };
    const edit = await request(`transactions/${approved.id}`, 'PATCH', { revision: approved.revision, amountCents: 12000 });
    expect(edit.status).toBe(200);
    const edited = await edit.json() as { revision: number };
    const move = await request(`transactions/${approved.id}/pending`, 'POST', { revision: edited.revision, note: 'Check amount' });
    expect(move.status).toBe(200);
    const returned = await move.json() as { id: string; revision: number };
    const reapproval = await request(`queue/${returned.id}/confirm`, 'POST', { transactionId: 't2', revision: returned.revision, transaction: { ...txInput, id: 't2', amountCents: 12000 } });
    expect(reapproval.status).toBe(201);
    const again = await reapproval.json() as { id: string; revision: number };
    expect((await repo().activeTransactions()).map((row) => row.id)).toEqual(['t2']);
    const close = await request('cycles/close', 'POST', { cycleId: 'full-cycle', transactionIds: [again.id], confirmed: true, revisions: { [again.id]: again.revision } });
    expect(close.status).toBe(201);
    const originalCycle = await repo().requireCycle('full-cycle');
    expect(originalCycle).toMatchObject({ status: 'closed', closedByMemberId: 'm1', closedByName: 'Sam', settledAt: null });
    const [closed] = await repo().transactionsByCycle('full-cycle');
    expect(JSON.parse(closed.splitSharesJson)).toEqual({ m1: 8400, m2: 3600 });
    const correction = await request(`transactions/${closed.id}`, 'PATCH', { revision: closed.revision, amountCents: 15000 });
    expect(correction.status).toBe(200);
    expect((await repo().transactionsByCycle('full-cycle'))[0]).toMatchObject({ expenseId: imported.expenseId, amountCents: 15000, cycleId: 'full-cycle' });
    expect(await repo().activeTransactions()).toEqual([]);
    expect(await repo().queueItems()).toEqual([left]);
    expect(await repo().requireCycle('full-cycle')).toEqual(originalCycle);
    expect(JSON.parse(originalCycle.closingSnapshotJson!).transactions[0].amountCents).toBe(12000);
    expect((await repo().cycleSettlement('full-cycle')).balances).toEqual({ m1: 4500, m2: -4500 });
    expect((await repo().expenseHistory(imported.expenseId)).map((event) => event.eventType)).toEqual(['edited', 'closed', 'approved', 'returned_to_pending', 'edited', 'approved', 'imported']);
  });

  it('adds closure attribution to populated legacy cycles without inventing actors or changing settlement', async () => {
    const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };
    await env.DB.exec('DROP TABLE cycles');
    const initial = TEST_MIGRATIONS.find((m) => m.name.startsWith('0000'))!;
    await env.DB.batch(initial.queries.filter((q) => /CREATE TABLE `cycles`/.test(q)).map((q) => env.DB.prepare(q)));
    const settlement = JSON.stringify({ balances: { m1: 500, m2: -500 }, transfers: [{ from: 'm2', to: 'm1', amountCents: 500 }] });
    await env.DB.prepare("INSERT INTO cycles (id, household_id, status, settlement_json, closed_at, settled_at) VALUES ('old-cycle', 'h1', 'settled', ?, 11, 22)").bind(settlement).run();
    const migration = TEST_MIGRATIONS.find((m) => m.name.startsWith('0004'))!;
    await env.DB.batch(migration.queries.map((q) => env.DB.prepare(q)));
    expect(await repo().requireCycle('old-cycle')).toMatchObject({ id: 'old-cycle', status: 'settled', settlementJson: settlement, closedAt: 11, settledAt: 22, closedByMemberId: null, closedByName: null, closingSnapshotJson: null });
    expect(await repo().cycleSettlement('old-cycle')).toEqual(JSON.parse(settlement));
    // Later migrations alter cycles too; replay them so the following tests see the current shape.
    const later = TEST_MIGRATIONS.filter((m) => m.name > migration.name).flatMap((m) => m.queries).filter((q) => /ALTER TABLE `cycles`/.test(q));
    await env.DB.batch(later.map((q) => env.DB.prepare(q)));
  });

  it('backfills unchanged legacy values with unknown actors and complete labeled baselines', async () => {
    const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };
    // Run the real migration against legacy-shaped tables, not a hand-written facsimile.
    await env.DB.exec('DROP TABLE IF EXISTS expense_history');
    await env.DB.exec('DROP TABLE transactions');
    await env.DB.exec('DROP TABLE queue_items');
    const initial = TEST_MIGRATIONS.find((m) => m.name.startsWith('0000'))!;
    await env.DB.batch(initial.queries.filter((q) => /CREATE TABLE `(?:transactions|queue_items)`|CREATE INDEX `tx_scope_idx`/.test(q)).map((q) => env.DB.prepare(q)));
    const provenance = TEST_MIGRATIONS.find((m) => m.name.startsWith('0002'))!;
    await env.DB.batch(provenance.queries.map((q) => env.DB.prepare(q)));
    await env.DB.prepare("INSERT INTO transactions (id, household_id, date, store, amount_cents, category, payer_id, split_type, split_rule_json, split_shares_json, created_at, updated_at) VALUES ('old-tx', 'h1', '2026-10-13', 'Old Market', 10000, 'groceries', 'm1', 'custom', ?, ?, 1, 2)")
      .bind(JSON.stringify(txInput.splitRule), JSON.stringify({ m1: 7000, m2: 3000 })).run();
    await env.DB.prepare("INSERT INTO queue_items (id, household_id, store, source, source_file_id, source_file_name, created_at) VALUES ('old-q', 'h1', 'Incomplete', 'image', 'old-file', 'receipt.png', 3)").run();
    const migration = TEST_MIGRATIONS.find((m) => m.name.startsWith('0003'))!;
    await env.DB.batch(migration.queries.map((q) => env.DB.prepare(q)));
    const approvalHistory = TEST_MIGRATIONS.find((m) => m.name.startsWith('0005'))!;
    await env.DB.batch(approvalHistory.queries.map((q) => env.DB.prepare(q)));
    const old = (await repo().activeTransactions())[0];
    expect(old).toMatchObject({ store: 'Old Market', category: 'groceries', amountCents: 10000, updatedAt: 2, revision: 1, editedByMemberId: null });
    const events = await repo().expenseHistory(old.expenseId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'legacy_baseline', actorMemberId: null, actorName: null, before: null,
      after: { store: 'Old Market', splitRuleJson: JSON.stringify(txInput.splitRule) } });
    const q = (await repo().queueItems())[0];
    expect(q).toMatchObject({ date: null, amountCents: null, sourceFileId: 'old-file', sourceFileName: 'receipt.png', splitRuleJson: null });
    expect((await repo().expenseHistory(q.expenseId))[0].actorMemberId).toBeNull();
  });
});

describe('atomic transaction breakdown', () => {
  const split = (revision = 1, amountCents = 3000, transactionId = 'split-child') => request('transactions/t1/split', 'POST', { revision, amountCents, transactionId });
  it('conserves signed money, frozen allocation, source and attributable history on retry', async () => {
    const pending = await repo().insertQueueItem({ ...queueInput, amountCents: -10000 });
    const original = await repo().confirmQueueItem(pending.id, 't1', { ...txInput, amountCents: -10000 }, pending.revision);
    await db().insert(householdMembers).values({ id: 'm3', householdId: 'h1', displayName: 'New member', createdAt: 0 });
    const response = await split(original.revision, -3000);
    expect(response.status).toBe(200);
    const saved = await response.json() as { original: { amountCents: number; revision: number }; separated: { amountCents: number; expenseId: string; splitSharesJson: string; source: string; sourceFileId: string; sourceFileName: string } };
    expect(saved.original).toMatchObject({ amountCents: -7000, revision: 3 });
    expect(saved.separated).toMatchObject({ amountCents: -3000, source: 'csv', sourceFileId: 'upload-1', sourceFileName: 'statement.csv' });
    expect(JSON.parse(saved.separated.splitSharesJson)).toEqual({ m1: -2100, m2: -900 });
    expect((await split(original.revision, -3000)).status).toBe(200);
    expect((await repo().activeTransactions()).reduce((sum, row) => sum + row.amountCents, 0)).toBe(-10000);
    expect(await repo().expenseHistory(original.expenseId)).toHaveLength(3);
    expect((await repo().expenseHistory(saved.separated.expenseId)).find(event => event.expenseId === saved.separated.expenseId)).toMatchObject({ actorName: 'Sam', eventType: 'created' });
  });
  it('rolls back both amounts and history when the child insert fails, then retries once', async () => {
    const original = await repo().insertTransaction(txInput);
    await env.DB.exec("CREATE TRIGGER fail_split BEFORE INSERT ON transactions WHEN NEW.id = 'split-child' BEGIN SELECT RAISE(ABORT, 'forced split failure'); END");
    try {
      expect((await split()).status).toBe(500);
      expect((await repo().activeTransactions()).map((row) => row.amountCents)).toEqual([10000]);
      expect(await repo().expenseHistory(original.expenseId)).toHaveLength(1);
    } finally { await env.DB.exec('DROP TRIGGER IF EXISTS fail_split'); }
    expect((await split()).status).toBe(200);
    expect((await repo().activeTransactions()).map((row) => row.amountCents).sort()).toEqual([3000, 7000]);
  });
  it('rejects stale originals and altered retry values without financial changes', async () => {
    const original = await repo().insertTransaction(txInput);
    await repo().updateTransaction(original.id, { store: 'New version' }, original.revision);
    expect((await split()).status).toBe(409);
    expect((await split(2)).status).toBe(200);
    expect((await split(2, 2000)).status).toBe(409);
    expect((await repo().activeTransactions()).reduce((sum, row) => sum + row.amountCents, 0)).toBe(10000);
  });
  it('keeps closed-unsettled corrections and separated expenses in the same cycle', async () => {
    const original = await repo().insertTransaction(txInput);
    await repo().closeCycle('closed-split', [original.id], { [original.id]: original.revision });
    const closed = (await repo().transactionsByCycle('closed-split'))[0];
    expect((await split(closed.revision)).status).toBe(200);
    const rows = await repo().transactionsByCycle('closed-split');
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(10000);
    expect(await repo().activeTransactions()).toEqual([]);
    expect((await split(closed.revision)).status).toBe(200);
  });
  it('denies settled expenses and cross-household originals', async () => {
    const original = await repo().insertTransaction(txInput);
    const cycle = await repo().closeCycle('closed-split', [original.id], { [original.id]: original.revision });
    await repo().settleCycle(cycle.id);
    expect((await split()).status).toBe(409);
    await new ScopedRepository(db(), 'h2').insertTransaction({ ...txInput, id: 'foreign-split', payerId: 'x1', splitType: 'equal', splitRule: null });
    expect((await request('transactions/foreign-split/split', 'POST', { revision: 1, amountCents: 3000, transactionId: 'split-child' })).status).toBe(404);
    expect((await repo().archivedTransactions())[0].amountCents).toBe(10000);
  });
  it('rejects missing revisions, invalid portions and existing child identities', async () => {
    await repo().insertTransaction(txInput);
    expect((await request('transactions/t1/split', 'POST', { amountCents: 3000, transactionId: 'split-child' })).status).toBe(400);
    for (const amount of [0, 10000, -3000, 10001]) expect((await split(1, amount)).status).toBe(400);
    await repo().insertTransaction({ ...txInput, id: 'split-child', amountCents: 123 });
    expect((await split()).status).toBe(409);
    expect((await repo().activeTransactions()).find((row) => row.id === 't1')?.amountCents).toBe(10000);
  });
});

describe('frozen custom participants with zero shares', () => {
  const full = { ...txInput, splitRule: { percentages: { m1: 100, m2: 0 } } };
  it('breaks down a saved 100/0 allocation without dropping the zero-percent member', async () => {
    const original = await repo().insertTransaction(full);
    expect(JSON.parse(original.splitSharesJson)).toEqual({ m1: 10000 });
    const response = await request('transactions/t1/split', 'POST', { revision: original.revision, amountCents: 3000, transactionId: 'zero-share-child' });
    expect(response.status).toBe(200);
    const saved = await response.json() as { original: { splitSharesJson: string; splitRuleJson: string }; separated: { splitSharesJson: string; splitRuleJson: string } };
    expect(JSON.parse(saved.original.splitSharesJson)).toEqual({ m1: 7000 });
    expect(JSON.parse(saved.separated.splitSharesJson)).toEqual({ m1: 3000 });
    expect(JSON.parse(saved.original.splitRuleJson)).toEqual({ percentages: { m1: 100, m2: 0 } });
    expect(saved.separated.splitRuleJson).toBe(saved.original.splitRuleJson);
  });
  it('changes only the saved amount without rejecting a preserved zero-percent member', async () => {
    const original = await repo().insertTransaction(full);
    const response = await request('transactions/t1', 'PATCH', { revision: original.revision, amountCents: 12000 });
    expect(response.status).toBe(200);
    const saved = await response.json() as { splitSharesJson: string; splitRuleJson: string };
    expect(JSON.parse(saved.splitSharesJson)).toEqual({ m1: 12000 });
    expect(JSON.parse(saved.splitRuleJson)).toEqual({ percentages: { m1: 100, m2: 0 } });
  });
  it('reapproves an edited returned amount with the same 100/0 allocation', async () => {
    const original = await repo().insertTransaction(full);
    const pending = await repo().returnToPending(original.id, original.revision);
    const changed = await repo().updateQueueItem(pending.id, { amountCents: 12000 }, pending.revision);
    const response = await request(`queue/${changed.id}/confirm`, 'POST', { revision: changed.revision, transactionId: 'reapproved-zero-share', transaction: { ...full, id: 'reapproved-zero-share', amountCents: 12000 } });
    expect(response.status).toBe(201);
    const saved = await response.json() as { splitSharesJson: string; splitRuleJson: string; expenseId: string };
    expect(JSON.parse(saved.splitSharesJson)).toEqual({ m1: 12000 });
    expect(JSON.parse(saved.splitRuleJson)).toEqual({ percentages: { m1: 100, m2: 0 } });
    expect(saved.expenseId).toBe(original.expenseId);
  });
});

describe('frozen participants ignore unrelated split-rule fields', () => {
  for (const [splitType, splitRule] of [
    ['single', { memberId: 'm1', percentages: { x1: 100 } }],
    ['custom', { percentages: { m1: 100, m2: 0 }, memberId: 'x1' }],
  ] as const) {
    it(`changes ${splitType} to equal without adding ignored foreign references`, async () => {
      const created = await request('transactions', 'POST', { ...txInput, splitType, splitRule });
      expect(created.status).toBe(201);
      const original = await created.json() as { revision: number };
      const response = await request('transactions/t1', 'PATCH', { revision: original.revision, splitType: 'equal', splitRule: null });
      expect(response.status).toBe(200);
      const saved = await response.json() as { splitSharesJson: string; splitRuleJson: string | null };
      expect(JSON.parse(saved.splitSharesJson)).toEqual({ m1: 5000, m2: 5000 });
      expect(saved.splitRuleJson).toBeNull();
    });
  }
});


describe('custom allocation completion boundaries', () => {
  it.each(['transactions', 'queue'])('rejects newly invalid totals through %s creation', async path => {
    for (const total of [99, 101, 99.9995]) {
      const response = await request(path, 'POST', {
        ...queueInput, id: `bad-${total}`, splitRule: { percentages: { m1: total, m2: 0 } },
      });
      expect(response.status).toBe(400);
    }
    expect(await repo().activeTransactions()).toEqual([]);
    expect(await repo().queueItems()).toEqual([]);
  });
  it.each(['transactions', 'queue'])('rejects invalid splitRule-only PATCH to %s without a write', async path => {
    const row = path === 'transactions' ? await repo().insertTransaction(txInput) : await repo().insertQueueItem(queueInput);
    const before = await repo().expenseHistory(row.expenseId);
    const response = await request(`${path}/${row.id}`, 'PATCH', {
      revision: row.revision, splitRule: { percentages: { m1: 99.9995, m2: 0 } },
    });
    expect(response.status).toBe(400);
    const saved = path === 'transactions' ? (await repo().activeTransactions())[0] : (await repo().queueItems())[0];
    expect(saved).toMatchObject({ revision: row.revision, splitRuleJson: row.splitRuleJson });
    expect(await repo().expenseHistory(row.expenseId)).toEqual(before);
  });
  it.each(['transactions', 'queue'])('rejects clearing a custom rule through %s PATCH', async path => {
    const row = path === 'transactions' ? await repo().insertTransaction(txInput) : await repo().insertQueueItem(queueInput);
    const response = await request(`${path}/${row.id}`, 'PATCH', { revision: row.revision, splitRule: null });
    expect(response.status).toBe(400);
  });
  it('preserves a stored legacy rule and refund participants during an unrelated edit', async () => {
    const row = await repo().insertTransaction(txInput);
    const legacy = ' { "percentages": { "m1":20, "m2":20 } } ';
    await env.DB.prepare('UPDATE transactions SET split_rule_json = ?, split_shares_json = ? WHERE id = ?')
      .bind(legacy, '{"m1":5000,"m2":5000}', row.id).run();
    const response = await request(`transactions/${row.id}`, 'PATCH', { revision: row.revision, category: 'Dining', amountCents: -5000 });
    expect(response.status).toBe(200);
    const saved = await response.json() as { splitRuleJson: string; splitSharesJson: string; amountCents: number };
    expect(saved.splitRuleJson).toBe(legacy);
    expect(saved.amountCents).toBe(-5000);
    expect(JSON.parse(saved.splitSharesJson)).toEqual({ m1: -2500, m2: -2500 });
  });
  it('preserves unchanged legacy allocations across return and reapproval', async () => {
    const row = await repo().insertTransaction(txInput);
    const legacy = '{"percentages":{"m1":20,"m2":20}}';
    await env.DB.prepare('UPDATE transactions SET split_rule_json = ?, split_shares_json = ? WHERE id = ?')
      .bind(legacy, '{"m1":5000,"m2":5000}', row.id).run();
    const pending = await repo().returnToPending(row.id, row.revision);
    const response = await request(`queue/${pending.id}/confirm`, 'POST', {
      revision: pending.revision, transactionId: 't2',
      transaction: { ...txInput, id: 't2', splitRule: { percentages: { m1: 20, m2: 20 } } },
    });
    expect(response.status).toBe(201);
    const saved = await response.json() as { splitRuleJson: string; splitSharesJson: string };
    expect(saved.splitRuleJson).toBe(legacy);
    expect(JSON.parse(saved.splitSharesJson)).toEqual({ m1: 5000, m2: 5000 });
  });
});


it('retains reordered legacy allocation bytes and frozen shares through PATCH and reapproval', async () => {
  const row = await repo().insertTransaction(txInput);
  const legacy = ' { "percentages": { "m1":20, "m2":20 } } ';
  const shares = '{"m1":6000,"m2":4000}';
  await env.DB.prepare('UPDATE transactions SET split_rule_json = ?, split_shares_json = ? WHERE id = ?')
    .bind(legacy, shares, row.id).run();
  const response = await request(`transactions/${row.id}`, 'PATCH', {
    revision: row.revision, category: 'Dining', splitRule: { percentages: { m2: 20, m1: 20 } },
  });
  expect(response.status).toBe(200);
  const edited = await response.json() as { revision: number; splitRuleJson: string; splitSharesJson: string };
  expect(edited.splitRuleJson).toBe(legacy);
  expect(edited.splitSharesJson).toBe(shares);
  const pending = await repo().returnToPending(row.id, edited.revision);
  const approved = await request(`queue/${pending.id}/confirm`, 'POST', {
    revision: pending.revision, transactionId: 't2',
    transaction: { ...txInput, id: 't2', splitRule: { percentages: { m2: 20, m1: 20 } } },
  });
  expect(approved.status).toBe(201);
  const saved = await approved.json() as { splitRuleJson: string; splitSharesJson: string };
  expect(saved.splitRuleJson).toBe(legacy);
  expect(saved.splitSharesJson).toBe(shares);
});
