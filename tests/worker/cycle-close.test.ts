import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { households, householdMembers, cards } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1', { memberId: 'm2', displayName: 'Hugo' });
const base = {
  date: '2024-06-09', store: 'Uber', amountCents: 1000, category: 'Transport',
  payerId: 'm1', cardId: 'c1', splitType: 'equal' as const, splitRule: null,
};

beforeEach(async () => {
  await env.DB.exec('DROP TRIGGER IF EXISTS fail_close');
  for (const t of ['transactions', 'queue_items', 'cycles', 'cards', 'household_members', 'households']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values({ id: 'h1', name: 'Ours', createdAt: 0 });
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0 },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1 },
  ]);
  await db().insert(cards).values({ id: 'c1', householdId: 'h1', memberId: 'm1', name: 'Original card' });
  for (const id of ['t1', 't2', 't3']) {
    await repo().insertTransaction({ id, ...base });
  }
});

describe('closeCycle', () => {
  it('claims exactly the listed transactions', async () => {
    await repo().closeCycle('cy1', ['t1', 't2'], { 't1': 1, 't2': 1 });
    expect(await repo().transactionsByCycle('cy1')).toHaveLength(2);
    expect(await repo().activeTransactions()).toHaveLength(1);
  });

  it('creates the cycle as closed with no settlement snapshot', async () => {
    const cycle = await repo().closeCycle('cy1', ['t1'], { 't1': 1 });
    expect(cycle.status).toBe('closed');
    expect(cycle.settlementJson).toBeNull();
    expect(cycle.settledAt).toBeNull();
  });

  it('leaves unlisted transactions active, so two partial closes stay separate', async () => {
    await repo().closeCycle('cy1', ['t1'], { 't1': 1 });
    await repo().closeCycle('cy2', ['t2'], { 't2': 1 });
    expect((await repo().transactionsByCycle('cy1')).map((t) => t.id)).toEqual(['t1']);
    expect((await repo().transactionsByCycle('cy2')).map((t) => t.id)).toEqual(['t2']);
  });

  it('refuses to claim a transaction already in a cycle, and rolls back', async () => {
    await repo().closeCycle('cy1', ['t1'], { 't1': 1 });
    await expect(repo().closeCycle('cy2', ['t1', 't2'], { 't1': 1, 't2': 1 })).rejects.toMatchObject({ status: 409 });
    // the failed close leaves no cycle behind and does not move t2
    expect(await repo().cycles()).toHaveLength(1);
    expect((await repo().activeTransactions()).map((t) => t.id).sort()).toEqual(['t2', 't3']);
  });

  it('refuses to claim a soft-deleted transaction', async () => {
    await repo().softDeleteTransaction('t1');
    await expect(repo().closeCycle('cy1', ['t1'], { 't1': 1 })).rejects.toThrow();
  });

  it('refuses an empty id list', async () => {
    await expect(repo().closeCycle('cy1', [], {  })).rejects.toThrow();
  });

  it('refuses a transaction from another household', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    const other = new ScopedRepository(db(), 'h2');
    await expect(other.closeCycle('cy9', ['t1'], { 't1': 1 })).rejects.toThrow();
    expect(await repo().activeTransactions()).toHaveLength(3);
  });
});


describe('versioned closure', () => {
  it('preserves original values and closer while corrections change live totals', async () => {
    const cycle = await repo().closeCycle('cy1', ['t1'], { t1: 1 });
    expect(cycle).toMatchObject({ closedByMemberId: 'm2', closedByName: 'Hugo', status: 'closed', settledAt: null });
    const original = JSON.parse(cycle.closingSnapshotJson!);
    expect(original.transactions[0]).toMatchObject({ id: 't1', revision: 2, cycleId: 'cy1', amountCents: 1000, cardNameSnapshot: 'Original card' });
    expect(original.members).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'm1', displayName: 'Sam' })]));
    const [closed] = await repo().transactionsByCycle('cy1');
    expect(closed.revision).toBe(2);
    await repo().updateTransaction('t1', { amountCents: 2000 }, 2);
    expect((await repo().cycleSettlement('cy1')).balances).toEqual({ m1: 1000, m2: -1000 });
    await env.DB.exec("UPDATE household_members SET display_name = 'Renamed' WHERE id = 'm1'");
    await env.DB.exec("UPDATE cards SET name = 'Renamed card' WHERE id = 'c1'");
    expect(await repo().requireCycle('cy1')).toEqual(cycle);
    expect(await repo().expenseHistory(closed.expenseId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'closed', actorMemberId: 'm2', actorName: 'Hugo',
        before: expect.objectContaining({ revision: 1, amountCents: 1000 }),
        after: expect.objectContaining({ revision: 2, cycleId: 'cy1', amountCents: 1000 }) }),
    ]));
  });

  it('rejects stale versions without claiming any selected expense', async () => {
    await repo().updateTransaction('t1', { amountCents: 2000 }, 1);
    await expect(repo().closeCycle('cy1', ['t1', 't2'], { t1: 1, t2: 1 })).rejects.toMatchObject({ status: 409 });
    expect(await repo().cycles()).toEqual([]);
    expect(await repo().activeTransactions()).toHaveLength(3);
  });

  it('guards all selected versions inside the atomic batch', async () => {
    const database = db();
    const originalBatch = database.batch.bind(database);
    vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
      await env.DB.exec("UPDATE transactions SET revision = revision + 1, amount_cents = 2000 WHERE id = 't2'");
      return originalBatch(statements);
    });
    await expect(new ScopedRepository(database, 'h1').closeCycle('cy1', ['t1', 't2'], { t1: 1, t2: 1 })).rejects.toMatchObject({ status: 409 });
    expect(await repo().cycles()).toEqual([]);
    expect(await repo().activeTransactions()).toHaveLength(3);
    expect((await env.DB.prepare("SELECT * FROM expense_history WHERE event_type = 'closed'").all()).results).toEqual([]);
  });

  it('rolls back cycle, claims and history when a later claim fails', async () => {
    await env.DB.exec("CREATE TRIGGER fail_close BEFORE UPDATE OF cycle_id ON transactions WHEN NEW.id = 't2' BEGIN SELECT RAISE(ABORT, 'close failure'); END");
    await expect(repo().closeCycle('cy1', ['t1', 't2'], { t1: 1, t2: 1 })).rejects.toThrow();
    expect(await repo().cycles()).toEqual([]);
    expect(await repo().activeTransactions()).toHaveLength(3);
    expect((await env.DB.prepare("SELECT * FROM expense_history WHERE event_type = 'closed'").all()).results).toEqual([]);
    await env.DB.exec('DROP TRIGGER fail_close');
  });

  it('leaves Pending untouched and rejects returned or deleted expense', async () => {
    const pending = await repo().returnToPending('t1', 1, 'Check payer');
    await expect(repo().closeCycle('cy1', ['t1', 't2'], { t1: 1, t2: 1 })).rejects.toMatchObject({ status: 409 });
    await repo().softDeleteTransaction('t2', 1);
    await expect(repo().closeCycle('cy1', ['t2', 't3'], { t2: 1, t3: 1 })).rejects.toMatchObject({ status: 409 });
    expect(await repo().cycles()).toEqual([]);
    await repo().closeCycle('cy2', ['t3'], { t3: 1 });
    expect(await repo().queueItems()).toEqual([pending]);
  });

  it('rejects repeated or competing closure without another event', async () => {
    await repo().closeCycle('cy1', ['t1'], { t1: 1 });
    await expect(repo().closeCycle('cy1', ['t1'], { t1: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(repo().closeCycle('cy2', ['t1', 't2'], { t1: 1, t2: 1 })).rejects.toMatchObject({ status: 409 });
    expect(await repo().cycles()).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM expense_history WHERE event_type = 'closed'").all()).results).toHaveLength(1);
    expect((await repo().activeTransactions()).map(t => t.id).sort()).toEqual(['t2', 't3']);
  });
});


afterEach(() => vi.restoreAllMocks());

async function largeSelection() {
  const ids = Array.from({ length: 105 }, (_, index) => `large-${index}`);
  for (const id of ids) await repo().insertTransaction({ id, ...base });
  return { ids, revisions: Object.fromEntries(ids.map(id => [id, 1])) };
}

function boundParameterCounts() {
  const counts: number[] = [];
  const prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, 'prepare').mockImplementation(query => {
    const statement = prepare(query);
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, 'bind').mockImplementation((...values) => {
      counts.push(values.length);
      return bind(...values);
    });
    return statement;
  });
  return counts;
}

describe('large closure selection', () => {
  it('closes 105 current expenses with every actual query within 100 bound parameters', async () => {
    const { ids, revisions } = await largeSelection();
    const counts = boundParameterCounts();
    await repo().closeCycle('cy-large', ids, revisions);
    expect(await repo().transactionsByCycle('cy-large')).toHaveLength(105);
    expect((await repo().activeTransactions()).map(row => row.id).sort()).toEqual(['t1', 't2', 't3']);
    expect((await env.DB.prepare("SELECT * FROM expense_history WHERE event_type = 'closed'").all()).results).toHaveLength(105);
    expect(counts.length).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(100);
    expect(counts.length).toBeLessThanOrEqual(50);
  });

  it('rejects a raced revision among 105 expenses without writing any closure state', async () => {
    const { ids, revisions } = await largeSelection();
    const counts = boundParameterCounts();
    const database = db();
    const runBatch = database.batch.bind(database);
    vi.spyOn(database, 'batch').mockImplementationOnce(async statements => {
      await env.DB.exec("UPDATE transactions SET revision = revision + 1 WHERE id = 'large-104'");
      return runBatch(statements);
    });
    await expect(new ScopedRepository(database, 'h1').closeCycle('cy-large', ids, revisions)).rejects.toMatchObject({ status: 409 });
    expect(await repo().cycles()).toEqual([]);
    expect(await repo().activeTransactions()).toHaveLength(108);
    expect((await env.DB.prepare("SELECT * FROM expense_history WHERE event_type = 'closed'").all()).results).toEqual([]);
    expect(counts.length).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(100);
    expect(counts.length).toBeLessThanOrEqual(50);
  });
});
