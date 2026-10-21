import { describe, expect, it } from 'vitest';
import { amountWeightsError, customPercentagesError, parsePercentageDraft, percentagesFromAmounts } from '../src/lib/percentages';
import { computeShares } from '../src/lib/settlement';

describe('percentage completion', () => {
  it.each(['', ' ', '-', '.', '1e', 'Infinity', 'NaN', '0x64', 'abc', '1.2.3', '-1', '101'])('rejects invalid completed draft %j', value => {
    expect(() => parsePercentageDraft(value)).toThrow(RangeError);
  });
  it.each([['0', 0], ['80', 80], ['.5', 0.5], ['50.', 50], ['1e-7', 0.0000001], ['12.3456789012345', 12.3456789012345]] as const)('retains supported precision for %s', (text, expected) => {
    expect(parsePercentageDraft(text)).toBe(expected);
  });
  it.each([99, 101, 99.9995, 99.9999999999])('rejects total %s instead of applying a business tolerance', total => {
    expect(customPercentagesError({ m1: total, m2: 0 })).not.toBeNull();
  });
  it('allows representation error in three equal percentages', () => {
    expect(customPercentagesError({ m1: 100 / 3, m2: 100 / 3, m3: 100 / 3 })).toBeNull();
  });
  it('retains zero-percent participants and decimal precision', () => {
    expect(customPercentagesError({ m1: 0, m2: 100 })).toBeNull();
    expect(customPercentagesError({ m1: 12.3456789012345, m2: 87.6543210987655 })).toBeNull();
  });
  it.each([NaN, Infinity, -1, 101])('rejects invalid percentage %s', value => {
    expect(customPercentagesError({ m1: value, m2: 100 })).not.toBeNull();
  });
  it('rejects empty allocations', () => {
    expect(customPercentagesError({})).not.toBeNull();
  });
});

describe('amount weights', () => {
  it('converts pre-tax amounts to percentages that total 100%', () => {
    const percentages = percentagesFromAmounts({ m1: 4000, m2: 2500 });
    expect(percentages.m1).toBeCloseTo(61.5384615, 6);
    expect(customPercentagesError(percentages)).toBeNull();
  });
  it('splits the full bill in the pre-tax proportion exactly in cents', () => {
    // $40 + $25 of food, $78.00 with tax and tip.
    const shares = computeShares(7800, 'custom', { percentages: percentagesFromAmounts({ m1: 4000, m2: 2500 }) }, ['m1', 'm2']);
    expect(shares).toEqual({ m1: 4800, m2: 3000 });
  });
  it('keeps typed amounts exact when they already equal the bill', () => {
    const cents = { m1: 1000, m2: 1000, m3: 1000 };
    expect(computeShares(3000, 'custom', { percentages: percentagesFromAmounts(cents) }, ['m1', 'm2', 'm3'])).toEqual(cents);
  });
  it('totals 100% across many awkward amounts', () => {
    for (let seed = 1; seed < 500; seed++) {
      const cents = { m1: (seed * 7919) % 100_000, m2: (seed * 104_729) % 100_000 + 1, m3: (seed * 31) % 977 };
      const percentages = percentagesFromAmounts(cents);
      expect(customPercentagesError(percentages)).toBeNull();
      const total = cents.m1 + cents.m2 + cents.m3;
      expect(computeShares(total, 'custom', { percentages }, ['m1', 'm2', 'm3'])).toEqual(
        Object.fromEntries(Object.entries(cents).filter(([, value]) => value > 0)),
      );
    }
  });
  it('rejects negative, fractional and all-zero amounts', () => {
    expect(amountWeightsError({ m1: -100, m2: 500 })).not.toBeNull();
    expect(amountWeightsError({ m1: 0.5, m2: 500 })).not.toBeNull();
    expect(amountWeightsError({ m1: 0, m2: 0 })).not.toBeNull();
    expect(amountWeightsError({})).not.toBeNull();
    expect(amountWeightsError({ m1: 0, m2: 500 })).toBeNull();
  });
});
