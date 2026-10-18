import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { households, householdMembers, cards } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1');

const base = {
  date: '2024-06-09', store: 'Uber', amountCents: 586, category: 'Transport',
  payerId: 'm1', cardId: 'c1', splitType: 'equal' as const, splitRule: null,
};

beforeEach(async () => {
  for (const t of ['transactions', 'cards', 'household_members', 'households']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values({ id: 'h1', name: 'Ours', createdAt: 0 });
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0 },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1 },
  ]);
  await db().insert(cards).values({ id: 'c1', householdId: 'h1', memberId: 'm1', name: 'Amex' });
});

describe('insertTransaction', () => {
  it('stores exact shares that sum to the amount', async () => {
    const tx = await repo().insertTransaction({ id: 't1', ...base, amountCents: 1001 });
    const shares = JSON.parse(tx.splitSharesJson);
    expect(Object.values(shares).reduce((a: number, b) => a + (b as number), 0)).toBe(1001);
    expect(shares).toEqual({ m1: 501, m2: 500 });
  });

  it('snapshots the card name so a later rename leaves history readable', async () => {
    const tx = await repo().insertTransaction({ id: 't1', ...base });
    expect(tx.cardNameSnapshot).toBe('Amex');
  });

  it('creates the transaction as active', async () => {
    const tx = await repo().insertTransaction({ id: 't1', ...base });
    expect(tx.cycleId).toBeNull();
    expect(await repo().activeTransactions()).toHaveLength(1);
  });

  it('is idempotent on a repeated id', async () => {
    await repo().insertTransaction({ id: 't1', ...base });
    await repo().insertTransaction({ id: 't1', ...base });
    expect(await repo().activeTransactions()).toHaveLength(1);
  });

  it('rejects a payer from another household', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values({
      id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0, sortOrder: 0,
    });
    await expect(repo().insertTransaction({ id: 't1', ...base, payerId: 'x1' })).rejects.toThrow();
  });
});

describe('insertTransactionsBulk', () => {
  it('inserts every row and returns them in request order', async () => {
    const rows = await repo().insertTransactionsBulk([
      { id: 't2', ...base, store: 'Lyft' },
      { id: 't1', ...base },
    ]);

    expect(rows.map((row) => row.id)).toEqual(['t2', 't1']);
    expect(await repo().activeTransactions()).toHaveLength(2);
  });

  it('is idempotent when the same batch is retried', async () => {
    const items = [{ id: 't1', ...base }, { id: 't2', ...base, store: 'Lyft' }];
    await repo().insertTransactionsBulk(items);
    await repo().insertTransactionsBulk(items);

    expect(await repo().activeTransactions()).toHaveLength(2);
  });

  it('rolls back the whole D1 batch when a later insert conflicts', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values({
      id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0, sortOrder: 0,
    });
    await new ScopedRepository(db(), 'h2').insertTransaction({
      id: 'taken', ...base, payerId: 'x1', cardId: null,
    });

    await expect(repo().insertTransactionsBulk([
      { id: 'fresh', ...base },
      { id: 'taken', ...base },
    ])).rejects.toThrow();

    expect(await repo().activeTransactions()).toHaveLength(0);
  });
});

describe('updateTransaction', () => {
  it('recomputes shares when the amount changes', async () => {
    await repo().insertTransaction({ id: 't1', ...base, amountCents: 1000 });
    const tx = await repo().updateTransaction('t1', { amountCents: 1001 });
    expect(JSON.parse(tx.splitSharesJson)).toEqual({ m1: 501, m2: 500 });
  });

  it('recomputes shares when the split type changes', async () => {
    await repo().insertTransaction({ id: 't1', ...base, amountCents: 1000 });
    const tx = await repo().updateTransaction('t1', {
      splitType: 'single', splitRule: { memberId: 'm2' },
    });
    expect(JSON.parse(tx.splitSharesJson)).toEqual({ m2: 1000 });
  });

  it('bumps updatedAt', async () => {
    const created = await repo().insertTransaction({ id: 't1', ...base });
    const updated = await repo().updateTransaction('t1', { store: 'Lyft' });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it('leaves shares byte-identical when the split is untouched, even after a participant is archived', async () => {
    const created = await repo().insertTransaction({ id: 't1', ...base, amountCents: 1000 });
    await db().update(householdMembers).set({ archivedAt: Date.now() }).where(eq(householdMembers.id, 'm2'));
    const updated = await repo().updateTransaction('t1', { store: 'Lyft' });
    expect(updated.splitSharesJson).toBe(created.splitSharesJson);
    expect(JSON.parse(updated.splitSharesJson)).toEqual({ m1: 500, m2: 500 });
  });

  it('keeps an archived participant in a recomputed split and still sums to the new amount', async () => {
    await repo().insertTransaction({ id: 't1', ...base, amountCents: 1000 });
    await db().update(householdMembers).set({ archivedAt: Date.now() }).where(eq(householdMembers.id, 'm2'));
    const updated = await repo().updateTransaction('t1', { amountCents: 1001 });
    const shares = JSON.parse(updated.splitSharesJson);
    expect(shares).toEqual({ m1: 501, m2: 500 });
    expect(Object.values(shares).reduce((a: number, b) => a + (b as number), 0)).toBe(1001);
  });

  it('allows an explicit re-split to name a member who joined after the transaction was created', async () => {
    await repo().insertTransaction({ id: 't1', ...base, amountCents: 1000 });
    await db().insert(householdMembers).values({ id: 'm3', householdId: 'h1', displayName: 'Zoe', createdAt: 0, sortOrder: 2 });
    const updated = await repo().updateTransaction('t1', {
      splitType: 'single', splitRule: { memberId: 'm3' },
    });
    expect(JSON.parse(updated.splitSharesJson)).toEqual({ m3: 1000 });
  });

  it('does not pull a member who joined after the transaction into an amount-only edit', async () => {
    await repo().insertTransaction({ id: 't1', ...base, amountCents: 1000 });
    await db().insert(householdMembers).values({ id: 'm3', householdId: 'h1', displayName: 'Zoe', createdAt: 0, sortOrder: 2 });
    const updated = await repo().updateTransaction('t1', { amountCents: 1001 });
    expect(JSON.parse(updated.splitSharesJson)).toEqual({ m1: 501, m2: 500 });
  });
});

describe('softDeleteTransaction', () => {
  it('removes the row from active listings but keeps it in the table', async () => {
    await repo().insertTransaction({ id: 't1', ...base });
    await repo().softDeleteTransaction('t1');
    expect(await repo().activeTransactions()).toHaveLength(0);
    const raw = await env.DB.prepare('SELECT deleted_at FROM transactions WHERE id = ?')
      .bind('t1').first<{ deleted_at: number | null }>();
    expect(raw?.deleted_at).not.toBeNull();
  });

  it('is a no-op on a row belonging to another household', async () => {
    await repo().insertTransaction({ id: 't1', ...base });
    const other = new ScopedRepository(db(), 'h2');
    await expect(other.softDeleteTransaction('t1')).rejects.toThrow();
    expect(await repo().activeTransactions()).toHaveLength(1);
  });
});
