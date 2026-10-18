import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { households, householdMembers } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1');

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'q1', date: '2024-06-09', store: 'Quillfern Market', amountCents: 2565,
  category: 'Groceries', payerId: 'm1', cardId: null, splitType: 'equal',
  source: 'csv' as const,
  ...overrides,
});

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

describe('insertQueueItemsBulk', () => {
  it('inserts every row in one call', async () => {
    const result = await repo().insertQueueItemsBulk([
      row({ id: 'q1' }),
      row({ id: 'q2', store: 'Uber' }),
    ]);
    expect(result.inserted).toBe(2);
    expect(result.created).toHaveLength(2);
    expect(await repo().queueItems()).toHaveLength(2);
  });

  it('flags two identical rows within the same upload as duplicates of each other, but still inserts both', async () => {
    const result = await repo().insertQueueItemsBulk([
      row({ id: 'q1' }),
      row({ id: 'q2' }),
    ]);
    expect(result.inserted).toBe(2);
    expect(result.duplicate).toBe(1); // the second row is flagged; the first stands as the original
    const items = await repo().queueItems();
    const flagged = items.filter((i) => i.isDuplicate === 1);
    expect(flagged).toHaveLength(1);
  });

  it('flags a row that matches an existing active transaction', async () => {
    await repo().insertTransaction({
      id: 'tx1', date: '2024-06-09', store: 'Quillfern Market', amountCents: 2565,
      category: 'Groceries', payerId: 'm1', cardId: null, splitType: 'equal', splitRule: null,
    });
    const result = await repo().insertQueueItemsBulk([row({ id: 'q1' })]);
    expect(result.inserted).toBe(1);
    expect(result.duplicate).toBe(1);
  });

  it('does not flag rows with different amounts, dates, or merchants as duplicates', async () => {
    const result = await repo().insertQueueItemsBulk([
      row({ id: 'q1' }),
      row({ id: 'q2', amountCents: 999 }),
      row({ id: 'q3', store: 'Totally Different Merchant' }),
      row({ id: 'q4', date: '2024-01-01' }),
    ]);
    expect(result.duplicate).toBe(0);
  });

  it('rejects the whole request before writing anything when one row is invalid', async () => {
    await expect(repo().insertQueueItemsBulk([
      row({ id: 'q1' }),
      row({ id: 'q2', payerId: 'not-a-member' }),
    ])).rejects.toThrow();
    expect(await repo().queueItems()).toHaveLength(0);
  });

  it('rejects duplicate ids within the same array before any DB access', async () => {
    await expect(repo().insertQueueItemsBulk([
      row({ id: 'dup' }),
      row({ id: 'dup' }),
    ])).rejects.toThrow();
    expect(await repo().queueItems()).toHaveLength(0);
  });

  it('rejects an empty array', async () => {
    await expect(repo().insertQueueItemsBulk([])).rejects.toThrow();
  });

  it('is idempotent: retrying the same upload creates zero extra rows', async () => {
    const items = [row({ id: 'q1' }), row({ id: 'q2', store: 'Uber' })];
    await repo().insertQueueItemsBulk(items);
    const retry = await repo().insertQueueItemsBulk(items);
    expect(retry.inserted).toBe(0);
    expect(retry.rejected).toBe(2);
    expect(await repo().queueItems()).toHaveLength(2);
  });

  it('scopes duplicate matching to the household', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values(
      { id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0, sortOrder: 0 },
    );
    await new ScopedRepository(db(), 'h2').insertTransaction({
      id: 'tx-theirs', date: '2024-06-09', store: 'Quillfern Market', amountCents: 2565,
      category: 'Groceries', payerId: 'x1', cardId: null, splitType: 'equal', splitRule: null,
    });
    const result = await repo().insertQueueItemsBulk([row({ id: 'q1' })]);
    expect(result.duplicate).toBe(0);
  });
});

describe('deleteQueueItems', () => {
  it('deletes only selected rows and preserves request order', async () => {
    await repo().insertQueueItemsBulk([
      row({ id: 'q1' }),
      row({ id: 'q2', store: 'Uber' }),
      row({ id: 'q3', store: 'Shell' }),
    ]);

    expect(await repo().deleteQueueItems(['q3', 'q1'])).toEqual(['q3', 'q1']);
    expect((await repo().queueItems()).map((item) => item.id)).toEqual(['q2']);
  });

  it('is idempotent when selected rows are gone or missing', async () => {
    await repo().insertQueueItem(row({ id: 'q1' }) as never);
    expect(await repo().deleteQueueItems(['q1', 'missing'])).toEqual(['q1']);
    expect(await repo().deleteQueueItems(['q1', 'missing'])).toEqual([]);
  });

  it('cannot delete another household queue row', async () => {
    await db().insert(households).values({ id: 'h2', name: 'Theirs', createdAt: 0 });
    await db().insert(householdMembers).values(
      { id: 'x1', householdId: 'h2', displayName: 'Stranger', createdAt: 0, sortOrder: 0 },
    );
    await new ScopedRepository(db(), 'h2').insertQueueItem(
      row({ id: 'theirs', payerId: 'x1' }) as never,
    );

    expect(await repo().deleteQueueItems(['theirs'])).toEqual([]);
    expect(await new ScopedRepository(db(), 'h2').queueItems()).toHaveLength(1);
  });
});


describe('bulk file provenance', () => {
  it('retains distinct same-name uploads alongside older rows after reload and cross-group deletion', async () => {
    const result = await repo().insertQueueItemsBulk([
      { ...row({ id: 'q1' }), sourceFileId: 'upload-a', sourceFileName: 'same.csv' },
      { ...row({ id: 'q2', store: 'Uber' }), sourceFileId: 'upload-b', sourceFileName: 'same.csv' },
      row({ id: 'legacy' }),
    ]);
    expect(result.created).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'q1', sourceFileId: 'upload-a', sourceFileName: 'same.csv' }),
      expect.objectContaining({ id: 'q2', sourceFileId: 'upload-b', sourceFileName: 'same.csv' }),
      expect.objectContaining({ id: 'legacy', sourceFileId: null, sourceFileName: null }),
    ]));
    expect(await repo().queueItems()).toEqual(expect.arrayContaining(result.created));
    expect(await repo().deleteQueueItems(['q1', 'q2'])).toEqual(['q1', 'q2']);
    expect((await repo().queueItems()).map((item) => item.id)).toEqual(['legacy']);
  });
});
