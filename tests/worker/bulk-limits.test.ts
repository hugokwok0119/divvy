import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { households, householdMembers, cards } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1', { memberId: 'm1', displayName: 'Sam' });
const base = { date: '2024-06-09', store: 'Merchant', amountCents: 1001, category: 'Other',
  payerId: 'm1', cardId: 'c1', splitType: 'equal' as const, splitRule: null };
const items = () => Array.from({ length: 200 }, (_, index) => ({ ...base, id: `large-${index}`, store: `Merchant ${index}` }));
const revisions = () => Object.fromEntries(items().map(row => [row.id, 1]));

beforeEach(async () => {
  for (const table of ['expense_history', 'transactions', 'queue_items', 'cycles', 'cards', 'household_members', 'households']) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await db().insert(households).values({ id: 'h1', name: 'Ours', createdAt: 0 });
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0 },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1 },
  ]);
  await db().insert(cards).values({ id: 'c1', householdId: 'h1', memberId: 'm1', name: 'Original card' });
});
afterEach(() => vi.restoreAllMocks());

async function seed(table: 'transactions' | 'queue_items') {
  const extraColumns = table === 'transactions' ? ', split_shares_json' : '';
  const extraValues = table === 'transactions' ? ", '{\"m1\":501,\"m2\":500}'" : '';
  await env.DB.prepare(`INSERT INTO ${table} (id, household_id, expense_id, date, store, amount_cents, category, payer_id, card_id, split_type, created_at, updated_at${extraColumns}) SELECT json_extract(value, '$.id'), 'h1', json_extract(value, '$.id'), json_extract(value, '$.date'), json_extract(value, '$.store'), 1001, 'Other', 'm1', 'c1', 'equal', 0, 0${extraValues} FROM json_each(?)`).bind(JSON.stringify(items())).run();
}

function queryLimits() {
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
  return () => {
    expect(counts.length).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(100);
    expect(counts.length).toBeLessThanOrEqual(50);
    vi.restoreAllMocks();
  };
}

async function history(type: string) {
  return (await env.DB.prepare('SELECT * FROM expense_history WHERE event_type = ?').bind(type).all()).results;
}

describe('200-row bulk operations within D1 limits', () => {
  it('imports transactions and retries with bounded parameters and queries', async () => {
    const check = queryLimits();
    const saved = await repo().insertTransactionsBulk(items());
    check();
    expect(saved.map(row => row.id)).toEqual(items().map(row => row.id));
    expect(saved[0]).toMatchObject({ cardNameSnapshot: 'Original card', splitSharesJson: '{"m1":501,"m2":500}', revision: 1 });
    expect(await history('imported')).toHaveLength(200);
    const retryCheck = queryLimits();
    expect(await repo().insertTransactionsBulk(items())).toEqual(saved);
    retryCheck();
    expect(await history('imported')).toHaveLength(200);
  });

  it('imports Pending rows with truthful results and bounded queries', async () => {
    const check = queryLimits();
    const result = await repo().insertQueueItemsBulk(items().map(row => ({ ...row, source: 'csv' as const })));
    check();
    expect(result).toMatchObject({ inserted: 200, rejected: 0, duplicate: 199 });
    expect(result.created).toHaveLength(200);
    expect(await history('imported')).toHaveLength(200);
    const retryCheck = queryLimits();
    expect(await repo().insertQueueItemsBulk(items().map(row => ({ ...row, source: 'csv' as const })))).toMatchObject({ inserted: 0, rejected: 200, created: [] });
    retryCheck();
  });

  it('deletes 200 Pending rows atomically with bounded parameters and queries', async () => {
    await seed('queue_items');
    const check = queryLimits();
    expect(await repo().deleteQueueItems(items().map(row => row.id), revisions())).toEqual(items().map(row => row.id));
    check();
    expect(await repo().queueItems()).toEqual([]);
    expect(await history('deleted')).toHaveLength(200);
  });

  it('applies 200 category suggestions with bounded queries', async () => {
    await seed('transactions');
    const check = queryLimits();
    expect(await repo().applyCategorySuggestions(items().map(row => ({ id: row.id, category: 'Dining', revision: 1 })))).toEqual({ applied: items().map(row => row.id), skipped: [] });
    check();
    expect((await repo().activeTransactions()).every(row => row.category === 'Dining' && row.revision === 2)).toBe(true);
    expect(await history('category_suggestion')).toHaveLength(200);
  });

  it('rejects one raced Pending revision without any deletion or false history', async () => {
    await seed('queue_items');
    const database = db();
    const batch = database.batch.bind(database);
    vi.spyOn(database, 'batch').mockImplementationOnce(async statements => {
      await env.DB.exec("UPDATE queue_items SET revision = 2 WHERE id = 'large-199'");
      return batch(statements);
    });
    const check = queryLimits();
    await expect(new ScopedRepository(database, 'h1').deleteQueueItems(items().map(row => row.id), revisions())).rejects.toMatchObject({ status: 409 });
    check();
    expect(await repo().queueItems()).toHaveLength(200);
    expect(await history('deleted')).toEqual([]);
  });

  it('rejects a raced existing transaction without importing any fresh selection', async () => {
    await seed('transactions');
    const database = db();
    const batch = database.batch.bind(database);
    vi.spyOn(database, 'batch').mockImplementationOnce(async statements => {
      await env.DB.exec("UPDATE transactions SET revision = 2 WHERE id = 'large-199'");
      return batch(statements);
    });
    const check = queryLimits();
    await expect(new ScopedRepository(database, 'h1').insertTransactionsBulk([...items().slice(1), { ...base, id: 'fresh' }])).rejects.toMatchObject({ status: 409 });
    check();
    expect(await repo().activeTransactions()).toHaveLength(200);
    expect(await history('imported')).toEqual([]);
  });

  it.each(['transaction', 'pending'] as const)('rolls back a 200-row %s import on a foreign primary-key collision', async kind => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values({ id: 'foreign-member', householdId: 'h2', displayName: 'Other', createdAt: 0 });
    const foreign = new ScopedRepository(db(), 'h2');
    const foreignInput = { ...base, id: 'large-199', payerId: 'foreign-member', cardId: null };
    if (kind === 'transaction') await foreign.insertTransaction(foreignInput);
    else await foreign.insertQueueItem({ ...foreignInput, source: 'csv' });
    const check = queryLimits();
    const target = repo();
    await expect(kind === 'transaction' ? target.insertTransactionsBulk(items())
      : target.insertQueueItemsBulk(items().map(row => ({ ...row, source: 'csv' as const })))).rejects.toThrow();
    check();
    expect(await repo().activeTransactions()).toEqual([]);
    expect(await repo().queueItems()).toEqual([]);
    expect((await env.DB.prepare("SELECT * FROM expense_history WHERE household_id = 'h1'").all()).results).toEqual([]);
  });

  it('returns only 199 inserted Pending rows when one input is consumed before the batch', async () => {
    const database = db();
    const batch = database.batch.bind(database);
    vi.spyOn(database, 'batch').mockImplementationOnce(async statements => {
      const pending = await repo().insertQueueItem({ ...items()[199], source: 'csv' });
      await repo().confirmQueueItem(pending.id, 'approved-concurrent', { ...base, id: 'approved-concurrent' }, pending.revision);
      return batch(statements);
    });
    const check = queryLimits();
    const result = await new ScopedRepository(database, 'h1').insertQueueItemsBulk(items().map(row => ({ ...row, source: 'csv' as const })));
    check();
    expect(result).toMatchObject({ inserted: 199, rejected: 1, duplicate: 198 });
    expect(result.created.map(row => row.id)).toEqual(items().slice(0, 199).map(row => row.id));
    expect(await repo().queueItems()).toHaveLength(199);
    expect(await history('imported')).toHaveLength(200);
  });

  it('skips only a raced suggestion without recording its history', async () => {
    await seed('transactions');
    const database = db();
    const batch = database.batch.bind(database);
    vi.spyOn(database, 'batch').mockImplementationOnce(async statements => {
      await env.DB.exec("UPDATE transactions SET revision = 2, category = 'Groceries' WHERE id = 'large-199'");
      return batch(statements);
    });
    const check = queryLimits();
    expect(await new ScopedRepository(database, 'h1').applyCategorySuggestions(items().map(row => ({ id: row.id, category: 'Dining', revision: 1 })))).toEqual({ applied: items().slice(0, 199).map(row => row.id), skipped: ['large-199'] });
    check();
    expect(await history('category_suggestion')).toHaveLength(199);
    expect((await repo().activeTransactions()).find(row => row.id === 'large-199')).toMatchObject({ category: 'Groceries', revision: 2 });
  });
});
