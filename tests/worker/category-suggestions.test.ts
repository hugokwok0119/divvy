import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { households, householdMembers } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1');
const base = {
  date: '2024-06-09', store: 'Tim Hortons', amountCents: 500, category: 'Other',
  payerId: 'm1', cardId: null, splitType: 'equal' as const, splitRule: null,
};

beforeEach(async () => {
  for (const t of ['transactions', 'cycles', 'household_members', 'households']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values([
    { id: 'h1', name: 'Ours', createdAt: 0 },
    { id: 'h2', name: 'Theirs', createdAt: 0 },
  ]);
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0 },
    { id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0, sortOrder: 0 },
  ]);
});

describe('applyCategorySuggestions', () => {
  it('applies a category to an active Other transaction', async () => {
    await repo().insertTransaction({ id: 't1', ...base });
    const result = await repo().applyCategorySuggestions([{ id: 't1', category: 'Dining' }]);
    expect(result).toEqual({ applied: ['t1'], skipped: [] });
    const [tx] = await repo().activeTransactions();
    expect(tx.category).toBe('Dining');
  });

  it('applies several updates in a single call (atomic bulk apply)', async () => {
    await repo().insertTransaction({ id: 't1', ...base, store: 'Tim Hortons' });
    await repo().insertTransaction({ id: 't2', ...base, store: 'Walmart' });
    const result = await repo().applyCategorySuggestions([
      { id: 't1', category: 'Dining' },
      { id: 't2', category: 'Groceries' },
    ]);
    expect(result.applied.sort()).toEqual(['t1', 't2']);
    const active = await repo().activeTransactions();
    expect(active.find((t) => t.id === 't1')?.category).toBe('Dining');
    expect(active.find((t) => t.id === 't2')?.category).toBe('Groceries');
  });

  it('never overwrites a row that is not currently Other', async () => {
    await repo().insertTransaction({ id: 't1', ...base, category: 'Dining' });
    const result = await repo().applyCategorySuggestions([{ id: 't1', category: 'Groceries' }]);
    expect(result).toEqual({ applied: [], skipped: ['t1'] });
    const [tx] = await repo().activeTransactions();
    expect(tx.category).toBe('Dining');
  });

  it('skips a row that has since been claimed into a closed cycle', async () => {
    await repo().insertTransaction({ id: 't1', ...base });
    await repo().closeCycle('cy1', ['t1'], { 't1': 1 });
    const result = await repo().applyCategorySuggestions([{ id: 't1', category: 'Dining' }]);
    expect(result).toEqual({ applied: [], skipped: ['t1'] });
    const [tx] = await repo().transactionsByCycle('cy1');
    expect(tx.category).toBe('Other');
  });

  it('skips a row that has since been deleted', async () => {
    await repo().insertTransaction({ id: 't1', ...base });
    await repo().softDeleteTransaction('t1');
    const result = await repo().applyCategorySuggestions([{ id: 't1', category: 'Dining' }]);
    expect(result).toEqual({ applied: [], skipped: ['t1'] });
  });

  it('never touches a row belonging to another household', async () => {
    await repo().insertTransaction({ id: 't1', ...base });
    const other = new ScopedRepository(db(), 'h2');
    const result = await other.applyCategorySuggestions([{ id: 't1', category: 'Dining' }]);
    expect(result).toEqual({ applied: [], skipped: ['t1'] });
    const [tx] = await repo().activeTransactions();
    expect(tx.category).toBe('Other');
  });

  it('applies the rows that still qualify and skips the ones that no longer do, in one call', async () => {
    await repo().insertTransaction({ id: 't1', ...base, store: 'Tim Hortons' });
    await repo().insertTransaction({ id: 't2', ...base, store: 'Walmart', category: 'Dining' });
    const result = await repo().applyCategorySuggestions([
      { id: 't1', category: 'Dining' },
      { id: 't2', category: 'Groceries' },
    ]);
    expect(result).toEqual({ applied: ['t1'], skipped: ['t2'] });
  });

  it('rejects a duplicate id within the same batch', async () => {
    await repo().insertTransaction({ id: 't1', ...base });
    await expect(repo().applyCategorySuggestions([
      { id: 't1', category: 'Dining' },
      { id: 't1', category: 'Groceries' },
    ])).rejects.toThrow();
  });

  it('is a no-op on an empty batch', async () => {
    expect(await repo().applyCategorySuggestions([])).toEqual({ applied: [], skipped: [] });
  });
});
