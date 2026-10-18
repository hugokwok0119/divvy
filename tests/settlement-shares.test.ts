import { describe, it, expect } from 'vitest';
import { distributeByWeight, computeShares } from '../src/lib/settlement';

const sum = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + b, 0);

describe('distributeByWeight', () => {
  it('splits evenly when it divides exactly', () => {
    expect(distributeByWeight(1000, { a: 1, b: 1 })).toEqual({ a: 500, b: 500 });
  });

  it('gives the odd cent to the stable-sorted first member', () => {
    expect(distributeByWeight(1001, { a: 1, b: 1 })).toEqual({ a: 501, b: 500 });
  });

  it('never loses or invents a cent splitting 1 cent three ways', () => {
    const s = distributeByWeight(1, { a: 1, b: 1, c: 1 });
    expect(sum(s)).toBe(1);
    expect(Object.values(s).sort()).toEqual([0, 0, 1]);
  });

  it('handles 1 cent across 20 participants', () => {
    const weights = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`m${String(i).padStart(2, '0')}`, 1])
    );
    const s = distributeByWeight(1, weights);
    expect(sum(s)).toBe(1);
    expect(Object.keys(s)).toHaveLength(20);
  });

  it('carries the sign through refunds', () => {
    const s = distributeByWeight(-329, { a: 1, b: 1 });
    expect(sum(s)).toBe(-329);
    expect(s).toEqual({ a: -165, b: -164 });
  });

  it('respects unequal weights', () => {
    const s = distributeByWeight(12523, { u1: 75, u2: 25 });
    expect(sum(s)).toBe(12523);
    expect(s.u1).toBe(9392);
    expect(s.u2).toBe(3131);
  });

  it('ignores zero and negative weights', () => {
    const s = distributeByWeight(100, { a: 1, b: 0 });
    expect(s).toEqual({ a: 100 });
  });

  it('is deterministic across key insertion order', () => {
    const a = distributeByWeight(1001, { b: 1, a: 1 });
    const b = distributeByWeight(1001, { a: 1, b: 1 });
    expect(a).toEqual(b);
  });

  it('throws when no positive weight exists', () => {
    expect(() => distributeByWeight(100, { a: 0 })).toThrow(RangeError);
  });

  it('always sums exactly, across a wide sweep', () => {
    for (let amount = -500; amount <= 500; amount++) {
      for (const n of [2, 3, 7]) {
        const w = Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, 1]));
        expect(sum(distributeByWeight(amount, w))).toBe(amount);
      }
    }
  });
});

describe('computeShares', () => {
  const roster = ['user_1', 'user_2'];

  it('equal splits across the whole roster', () => {
    expect(computeShares(1001, 'equal', null, roster)).toEqual({ user_1: 501, user_2: 500 });
  });

  it('single assigns the whole amount to one member', () => {
    expect(computeShares(6600, 'single', { memberId: 'user_2' }, roster))
      .toEqual({ user_2: 6600 });
  });

  it('custom uses percentages', () => {
    const s = computeShares(23313, 'custom', { percentages: { user_1: 15, user_2: 85 } }, roster);
    expect(sum(s)).toBe(23313);
    expect(s.user_1).toBe(3497);
    expect(s.user_2).toBe(19816);
  });

  it('rejects a single split naming someone off the roster', () => {
    expect(() => computeShares(100, 'single', { memberId: 'ghost' }, roster)).toThrow(RangeError);
  });

  it('rejects custom percentages naming someone off the roster', () => {
    expect(() => computeShares(100, 'custom', { percentages: { ghost: 100 } }, roster))
      .toThrow(RangeError);
  });

  it('rejects an empty roster', () => {
    expect(() => computeShares(100, 'equal', null, [])).toThrow(RangeError);
  });
});
