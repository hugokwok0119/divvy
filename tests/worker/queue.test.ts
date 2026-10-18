import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { households, householdMembers } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1');

const queued = {
  id: 'q1', date: '2024-06-09', store: 'Quillfern Market', amountCents: 2565,
  category: 'Groceries', payerId: 'm1', cardId: null, splitType: 'equal',
  source: 'image' as const,
};

const confirmInput = {
  id: 'tx-from-q1', date: '2024-06-09', store: 'Quillfern Market', amountCents: 2565,
  category: 'Groceries', payerId: 'm1', cardId: null,
  splitType: 'equal' as const, splitRule: null,
};

beforeEach(async () => {
  for (const t of ['transactions', 'cycles', 'queue_items', 'category_preferences', 'household_members', 'households']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values({ id: 'h1', name: 'Ours', createdAt: 0 });
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0 },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1 },
  ]);
});

describe('queue storage', () => {
  it('accepts an item with unknown fields left null', async () => {
    const item = await repo().insertQueueItem({
      id: 'q2', date: null, store: 'Uber', amountCents: null, category: null,
      payerId: null, cardId: null, splitType: null, source: 'image',
    });
    expect(item.amountCents).toBeNull();
    expect(item.date).toBeNull();
  });

  it('is idempotent on a repeated id', async () => {
    await repo().insertQueueItem(queued);
    await repo().insertQueueItem(queued);
    expect(await repo().queueItems()).toHaveLength(1);
  });

  it('lists only its own household items', async () => {
    await repo().insertQueueItem(queued);
    expect(await new ScopedRepository(db(), 'h2').queueItems()).toHaveLength(0);
  });
});

describe('confirmQueueItem', () => {
  beforeEach(async () => { await repo().insertQueueItem(queued); });

  it('creates the transaction and removes the queue row', async () => {
    const tx = await repo().confirmQueueItem('q1', 'tx-from-q1', confirmInput);
    expect(tx.amountCents).toBe(2565);
    expect(await repo().queueItems()).toHaveLength(0);
    expect(await repo().activeTransactions()).toHaveLength(1);
  });

  it('does not learn from accepting an unchanged AI category', async () => {
    await repo().confirmQueueItem('q1', 'tx-from-q1', confirmInput);
    expect(await repo().categoryPreferences()).toEqual({});
  });

  it('does not learn fallback Other when queue category was blank', async () => {
    await repo().deleteQueueItem('q1');
    await repo().insertQueueItem({ ...queued, id: 'blank-q', category: null });
    await repo().confirmQueueItem('blank-q', 'blank-tx', {
      ...confirmInput,
      id: 'blank-tx',
      category: 'Other',
    });

    expect(await repo().categoryPreferences()).toEqual({});
  });

  it('creates exactly one transaction when retried', async () => {
    await repo().confirmQueueItem('q1', 'tx-from-q1', confirmInput);
    await repo().confirmQueueItem('q1', 'tx-from-q1', confirmInput);
    expect(await repo().activeTransactions()).toHaveLength(1);
  });

  it('returns the same transaction on retry, after the queue item is already gone', async () => {
    const first = await repo().confirmQueueItem('q1', 'tx-from-q1', confirmInput);
    const second = await repo().confirmQueueItem('q1', 'tx-from-q1', confirmInput);
    expect(second.id).toBe(first.id);
    expect(await repo().activeTransactions()).toHaveLength(1);
  });

  it('refuses a queue item from another household', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values(
      { id: 'm3', householdId: 'h2', displayName: 'Someone', createdAt: 0, sortOrder: 0 },
    );
    // payerId is valid in h2, so a payer-ownership check cannot be what
    // rejects this — only the queue item's own household membership can.
    await expect(
      new ScopedRepository(db(), 'h2').confirmQueueItem('q1', 'tx-x', { ...confirmInput, payerId: 'm3' }),
    ).rejects.toThrow();
  });
});

describe('categoryPreferences', () => {
  it('does not backfill preferences from a closed billing cycle', async () => {
    await repo().insertTransaction({
      ...confirmInput,
      id: 'historical-tx',
      store: 'Tim Hortons',
      category: 'Dining',
    });
    await repo().closeCycle('historical-cycle', ['historical-tx'], { 'historical-tx': 1 });

    expect(await repo().categoryPreferences()).toEqual({});
  });

  it('saves an explicit queue relabel as the merchant preference', async () => {
    await repo().insertQueueItem({
      ...queued,
      id: 'new-q',
      store: 'Tim Hortons',
      category: 'Other',
    });
    await repo().updateQueueItem('new-q', { category: 'Dining' });

    expect(await repo().categoryPreferences()).toEqual({
      'tim hortons': 'Dining',
    });
  });

  it('saves an explicit transaction relabel as the merchant preference', async () => {
    await repo().insertTransaction({
      ...confirmInput,
      id: 'active-tx',
      store: 'Tim Hortons',
      category: 'Other',
    });
    await repo().updateTransaction('active-tx', { category: 'Dining' });

    expect(await repo().categoryPreferences()).toEqual({
      'tim hortons': 'Dining',
    });
  });

  it('does not learn when category patch leaves category unchanged', async () => {
    await repo().insertQueueItem({ ...queued, id: 'same-q' });
    await repo().updateQueueItem('same-q', { category: 'Groceries' });
    expect(await repo().categoryPreferences()).toEqual({});
  });
});


describe('queue file provenance', () => {
  it('persists a single upload through reload and ordinary edits', async () => {
    const input = { ...queued, sourceFileId: 'upload-1', sourceFileName: 'statement.pdf' };
    expect(await repo().insertQueueItem(input)).toMatchObject({ sourceFileId: 'upload-1', sourceFileName: 'statement.pdf' });
    expect((await repo().queueItems())[0]).toMatchObject({ sourceFileId: 'upload-1', sourceFileName: 'statement.pdf' });
    await repo().updateQueueItem(input.id, { store: 'Edited store', sourceFileId: 'changed', sourceFileName: 'other.pdf' });
    expect((await repo().queueItems())[0]).toMatchObject({ store: 'Edited store', sourceFileId: 'upload-1', sourceFileName: 'statement.pdf' });
    expect(await new ScopedRepository(db(), 'h2').queueItems()).toEqual([]);
  });

  it('loads legacy inputs with nullable provenance', async () => {
    await repo().insertQueueItem(queued);
    expect((await repo().queueItems())[0]).toMatchObject({ sourceFileId: null, sourceFileName: null });
  });
});
