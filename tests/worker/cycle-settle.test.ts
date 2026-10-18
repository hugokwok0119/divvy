import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { households, householdMembers } from '../../worker/db/schema';
import { ScopedRepository } from '../../worker/lib/scope';

const db = () => drizzle(env.DB);
const repo = () => new ScopedRepository(db(), 'h1');
const base = {
  date: '2024-06-09', store: 'Uber', category: 'Transport',
  payerId: 'm1', cardId: null, splitType: 'equal' as const, splitRule: null,
};

beforeEach(async () => {
  for (const t of ['transactions', 'cycles', 'household_members', 'households']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await db().insert(households).values({ id: 'h1', name: 'Ours', createdAt: 0 });
  await db().insert(householdMembers).values([
    { id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, sortOrder: 0 },
    { id: 'm2', householdId: 'h1', displayName: 'Hugo', createdAt: 0, sortOrder: 1 },
  ]);
  await repo().insertTransaction({ id: 't1', ...base, amountCents: 1000 });
  await repo().closeCycle('cy1', ['t1'], { 't1': 1 });
});

describe('cycleSettlement while closed', () => {
  it('computes live from the stored shares', async () => {
    const s = await repo().cycleSettlement('cy1');
    expect(s.balances).toEqual({ m1: 500, m2: -500 });
    expect(s.transfers).toEqual([{ from: 'm2', to: 'm1', amountCents: 500 }]);
  });

  it('reflects an edit made during review', async () => {
    await repo().updateTransaction('t1', { amountCents: 2000 });
    const s = await repo().cycleSettlement('cy1');
    expect(s.balances.m1).toBe(1000);
  });

  it('is never zero the way the prototype stored it', async () => {
    expect((await repo().cycleSettlement('cy1')).balances.m1).not.toBe(0);
  });
});

describe('settleCycle', () => {
  it('freezes the snapshot and marks the cycle settled', async () => {
    const cycle = await repo().settleCycle('cy1');
    expect(cycle.status).toBe('settled');
    expect(cycle.settledAt).not.toBeNull();
    expect(JSON.parse(cycle.settlementJson!).balances).toEqual({ m1: 500, m2: -500 });
  });

  it('returns the frozen snapshot afterwards, not a recomputation', async () => {
    await repo().settleCycle('cy1');
    // force the underlying data to disagree with the snapshot
    await env.DB.exec("UPDATE transactions SET amount_cents = 9999 WHERE id = 't1'");
    expect((await repo().cycleSettlement('cy1')).balances.m1).toBe(500);
  });

  it('refuses to settle twice', async () => {
    await repo().settleCycle('cy1');
    await expect(repo().settleCycle('cy1')).rejects.toThrow(/already settled/i);
  });

  it('throws rather than recomputing when settled with no snapshot', async () => {
    await repo().settleCycle('cy1');
    // simulate an impossible state: settled but the snapshot got wiped
    await env.DB.exec("UPDATE cycles SET settlement_json = NULL WHERE id = 'cy1'");
    await expect(repo().cycleSettlement('cy1')).rejects.toThrow();
  });
});

describe('unsettleCycle', () => {
  it('reopens a settled cycle and discards the frozen snapshot', async () => {
    await repo().settleCycle('cy1');

    const cycle = await repo().unsettleCycle('cy1');

    expect(cycle.status).toBe('closed');
    expect(cycle.settlementJson).toBeNull();
    expect(cycle.settledAt).toBeNull();
    expect((await repo().cycleSettlement('cy1')).balances).toEqual({ m1: 500, m2: -500 });
  });

  it('refuses to reopen a cycle that is not settled', async () => {
    await expect(repo().unsettleCycle('cy1')).rejects.toThrow(/not settled/i);
  });
});

describe('assertCycleEditable', () => {
  it('allows editing an active transaction', async () => {
    await expect(repo().assertCycleEditable(null)).resolves.toBeUndefined();
  });

  it('allows editing inside a closed cycle, which is the review window', async () => {
    await expect(repo().assertCycleEditable('cy1')).resolves.toBeUndefined();
  });

  it('refuses editing inside a settled cycle', async () => {
    await repo().settleCycle('cy1');
    await expect(repo().assertCycleEditable('cy1')).rejects.toThrow(/settled/i);
  });
});

describe('updateTransaction inside a settled cycle', () => {
  it('is refused', async () => {
    await repo().settleCycle('cy1');
    await expect(repo().updateTransaction('t1', { amountCents: 5 })).rejects.toThrow(/settled/i);
  });
});

describe('softDeleteTransaction inside a settled cycle', () => {
  it('is refused', async () => {
    await repo().settleCycle('cy1');
    await expect(repo().softDeleteTransaction('t1')).rejects.toThrow(/settled/i);
  });
});
