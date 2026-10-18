import { describe, it, expect } from 'vitest';
import { aggregateAnalytics, formatMonthLabel, computeYAxisTicks, formatCentsWithSymbol } from '../src/lib/money';

describe('aggregateAnalytics', () => {
  it('nets purchases and refunds: $200 purchases, $50 refund -> $150 net', () => {
    const stats = aggregateAnalytics([
      { amountCents: 20000, category: 'Groceries', date: '2024-06-01' },
      { amountCents: -5000, category: 'Groceries', date: '2024-06-02' },
    ]);
    expect(stats.netSpending).toBe(15000);
    expect(stats.grossPurchases).toBe(20000);
    expect(stats.refunds).toBe(5000);
  });

  it('excludes refund transactions from category totals (gross purchases only)', () => {
    const stats = aggregateAnalytics([
      { amountCents: 3000, category: 'Dining', date: '2024-06-01' },
      { amountCents: -1000, category: 'Dining', date: '2024-06-01' },
    ]);
    expect(stats.categoryTotals).toEqual({ Dining: 3000 });
  });

  it('keeps monthly totals signed, allowing a negative net month', () => {
    const stats = aggregateAnalytics([
      { amountCents: 1000, category: 'Dining', date: '2024-06-01' },
      { amountCents: -3000, category: 'Dining', date: '2024-06-15' },
    ]);
    expect(stats.monthTotals).toEqual({ '2024-06': -2000 });
  });

  it('returns zeros for an empty input', () => {
    const stats = aggregateAnalytics([]);
    expect(stats).toEqual({ netSpending: 0, grossPurchases: 0, refunds: 0, monthTotals: {}, categoryTotals: {} });
  });
});

describe('formatMonthLabel', () => {
  it('renders locale month abbreviation plus full year', () => {
    expect(formatMonthLabel('2024-06')).toBe('Jun 2024');
    expect(formatMonthLabel('2024-01')).toBe('Jan 2024');
    expect(formatMonthLabel('2024-12')).toBe('Dec 2024');
  });

  it('disambiguates the same month across different years', () => {
    expect(formatMonthLabel('2023-06')).not.toBe(formatMonthLabel('2024-06'));
  });
});

describe('computeYAxisTicks', () => {
  it('splits an ascending range into evenly spaced ticks including both ends', () => {
    expect(computeYAxisTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it('handles a negative-to-positive range', () => {
    expect(computeYAxisTicks(-2000, 1000, 3)).toEqual([-2000, -1000, 0, 1000]);
  });

  it.each([
    [0, 12345, [0, 3086, 6173, 9259, 12345]],
    [-12345, 6789, [-12345, -7561, -2778, 2006, 6789]],
    [-12345, 0, [-12345, -9259, -6172, -3086, 0]],
    [0, 1, [0, 1]],
    [-1, 1, [-1, 0, 1]],
    [0, 0, [0]],
    [500, 500, [500]],
  ] as const)('keeps %i..%i cent ticks whole, bounded, and distinct', (min, max, expected) => {
    const ticks = computeYAxisTicks(min, max);
    expect(ticks).toEqual(expected);
    expect(ticks[0]).toBe(min);
    expect(ticks.at(-1)).toBe(max);
    expect(new Set(ticks).size).toBe(ticks.length);
    for (const tick of ticks) {
      expect(Number.isInteger(tick)).toBe(true);
      expect(formatCentsWithSymbol(tick)).toMatch(/^-?\$\d+\.\d{2}$/);
    }
  });
});
