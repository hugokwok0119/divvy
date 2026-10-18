import { describe, it, expect } from 'vitest';
import { computeBalances, minimalTransfers, computeSettlement, combinedSettlement } from '../src/lib/settlement';

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe('computeBalances', () => {
  it('credits the payer and debits each consumer', () => {
    const b = computeBalances(
      [{ payerId: 'a', amountCents: 1000, shares: { a: 500, b: 500 } }],
      ['a', 'b'],
    );
    expect(b).toEqual({ a: 500, b: -500 });
  });

  it('sums to exactly zero', () => {
    const b = computeBalances(
      [
        { payerId: 'a', amountCents: 1001, shares: { a: 501, b: 500 } },
        { payerId: 'b', amountCents: 333, shares: { a: 111, b: 111, c: 111 } },
      ],
      ['a', 'b', 'c'],
    );
    expect(sum(b)).toBe(0);
  });

  it('includes roster members with no activity at zero', () => {
    const b = computeBalances([], ['a', 'b']);
    expect(b).toEqual({ a: 0, b: 0 });
  });

  it('keeps an archived member who appears only in an old share snapshot', () => {
    const b = computeBalances(
      [{ payerId: 'a', amountCents: 900, shares: { a: 300, b: 300, gone: 300 } }],
      ['a', 'b'],
    );
    expect(b.gone).toBe(-300);
    expect(sum(b)).toBe(0);
  });

  it('handles refunds', () => {
    const b = computeBalances(
      [{ payerId: 'a', amountCents: -329, shares: { a: -165, b: -164 } }],
      ['a', 'b'],
    );
    expect(b).toEqual({ a: -164, b: 164 });
    expect(sum(b)).toBe(0);
  });

  it('throws when a share map does not sum to the amount', () => {
    expect(() =>
      computeBalances([{ payerId: 'a', amountCents: 1000, shares: { a: 400, b: 500 } }], ['a', 'b']),
    ).toThrow(RangeError);
  });
});

describe('minimalTransfers', () => {
  it('produces one transfer for two people', () => {
    expect(minimalTransfers({ a: 500, b: -500 })).toEqual([
      { from: 'b', to: 'a', amountCents: 500 },
    ]);
  });

  it('produces nothing when everyone is square', () => {
    expect(minimalTransfers({ a: 0, b: 0 })).toEqual([]);
  });

  it('clears every balance for a larger group', () => {
    const balances = { a: 700, b: -250, c: -450 };
    const transfers = minimalTransfers(balances);
    const after: Record<string, number> = { ...balances };
    for (const t of transfers) {
      after[t.from] += t.amountCents;
      after[t.to] -= t.amountCents;
    }
    expect(Object.values(after).every((v) => v === 0)).toBe(true);
  });

  it('uses at most n-1 transfers', () => {
    const balances = { a: 300, b: 200, c: -100, d: -400 };
    expect(minimalTransfers(balances).length).toBeLessThanOrEqual(3);
  });

  it('is deterministic', () => {
    const b = { a: 700, b: -250, c: -450 };
    expect(minimalTransfers(b)).toEqual(minimalTransfers({ c: -450, a: 700, b: -250 }));
  });

  it('throws when balances do not sum to zero', () => {
    expect(() => minimalTransfers({ a: 100, b: 0 })).toThrow(RangeError);
  });
});

describe('computeSettlement', () => {
  it('returns balances and transfers together', () => {
    const s = computeSettlement(
      [{ payerId: 'a', amountCents: 1000, shares: { a: 500, b: 500 } }],
      ['a', 'b'],
    );
    expect(s.balances).toEqual({ a: 500, b: -500 });
    expect(s.transfers).toEqual([{ from: 'b', to: 'a', amountCents: 500 }]);
  });
});

describe('combinedSettlement', () => {
  const cycle = (id: string, balances: Record<string, number>, status: 'closed' | 'settled' = 'closed') =>
    ({ id, status, settlement: { balances } });

  it('nets opposite-direction cycles instead of summing transfers', () => {
    // A owes B $50 in one cycle; B owes A $30 in another.
    const out = combinedSettlement([cycle('c1', { a: -5000, b: 5000 }), cycle('c2', { a: 3000, b: -3000 })]);
    expect(out.balances).toEqual({ a: -2000, b: 2000 });
    expect(out.transfers).toEqual([{ from: 'a', to: 'b', amountCents: 2000 }]);
    expect(out.cycleIds).toEqual(['c1', 'c2']);
  });

  it('nets three or more members across cycles', () => {
    const out = combinedSettlement([
      cycle('c1', { a: 6000, b: -3000, c: -3000 }),
      cycle('c2', { a: -1000, b: 4000, c: -3000 }),
    ]);
    expect(out.balances).toEqual({ a: 5000, b: 1000, c: -6000 });
    expect(out.transfers).toEqual([
      { from: 'c', to: 'a', amountCents: 5000 },
      { from: 'c', to: 'b', amountCents: 1000 },
    ]);
  });

  it('returns no transfers when the selection nets to zero', () => {
    const out = combinedSettlement([cycle('c1', { a: -2500, b: 2500 }), cycle('c2', { a: 2500, b: -2500 })]);
    expect(out.balances).toEqual({ a: 0, b: 0 });
    expect(out.transfers).toEqual([]);
  });

  it('excludes settled cycles even when they are selected', () => {
    const cycles = [cycle('c1', { a: -5000, b: 5000 }), cycle('paid', { a: -9000, b: 9000 }, 'settled')];
    expect(combinedSettlement(cycles).cycleIds).toEqual(['c1']);
    const picked = combinedSettlement(cycles, ['paid', 'c1']);
    expect(picked.cycleIds).toEqual(['c1']);
    expect(picked.transfers).toEqual([{ from: 'a', to: 'b', amountCents: 5000 }]);
  });

  it('counts a duplicated selection once and ignores ids no longer loaded', () => {
    const cycles = [cycle('c1', { a: -5000, b: 5000 }), cycle('c2', { a: 3000, b: -3000 })];
    const out = combinedSettlement(cycles, ['c1', 'c1', 'gone']);
    expect(out.cycleIds).toEqual(['c1']);
    expect(out.transfers).toEqual([{ from: 'a', to: 'b', amountCents: 5000 }]);
  });

  it('covers nothing for an empty selection', () => {
    const out = combinedSettlement([cycle('c1', { a: -5000, b: 5000 })], []);
    expect(out.cycleIds).toEqual([]);
    expect(out.transfers).toEqual([]);
  });
});
