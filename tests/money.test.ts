import { describe, it, expect } from 'vitest';
import { parseAmountToCents, formatCents, formatCentsWithSymbol, statementDateFor, closedCycleCard } from '../src/lib/money';

describe('parseAmountToCents', () => {
  it('parses plain decimals', () => {
    expect(parseAmountToCents('12.34')).toBe(1234);
    expect(parseAmountToCents('0.01')).toBe(1);
    expect(parseAmountToCents('100')).toBe(10000);
  });

  it('parses negatives, which are refunds', () => {
    expect(parseAmountToCents('-3.29')).toBe(-329);
    expect(parseAmountToCents('-98.78')).toBe(-9878);
  });

  it('strips currency symbols, commas, and whitespace', () => {
    expect(parseAmountToCents(' $1,234.56 ')).toBe(123456);
    expect(parseAmountToCents('-$72.80')).toBe(-7280);
  });

  it('rounds half away from zero at the third decimal', () => {
    expect(parseAmountToCents('1.005')).toBe(101);
    expect(parseAmountToCents('-1.005')).toBe(-101);
  });

  it('never produces a float', () => {
    expect(Number.isInteger(parseAmountToCents('33.333'))).toBe(true);
  });

  it('throws on unparseable input', () => {
    expect(() => parseAmountToCents('')).toThrow(RangeError);
    expect(() => parseAmountToCents('abc')).toThrow(RangeError);
    expect(() => parseAmountToCents('1.2.3')).toThrow(RangeError);
  });

  it('parses amounts that lose precision when multiplied as floats', () => {
    // These products land just below .5 in IEEE-754, so a float-based
    // implementation rounds them down: 1.015*100 is 101.49999999999999
    // and 0.145*100 is 14.499999999999998.
    expect(parseAmountToCents('1.015')).toBe(102);
    expect(parseAmountToCents('0.145')).toBe(15);
  });

  it('never returns a signed zero', () => {
    expect(Object.is(parseAmountToCents('-0.001'), 0)).toBe(true);
    expect(Object.is(parseAmountToCents('-0.00'), 0)).toBe(true);
  });
});

describe('formatCents', () => {
  it('formats to two decimals', () => {
    expect(formatCents(1234)).toBe('12.34');
    expect(formatCents(1)).toBe('0.01');
    expect(formatCents(0)).toBe('0.00');
    expect(formatCents(-329)).toBe('-3.29');
  });

  it('round trips with parseAmountToCents', () => {
    for (const c of [0, 1, -1, 999, -9878, 294356]) {
      expect(parseAmountToCents(formatCents(c))).toBe(c);
    }
  });
});

describe('formatCentsWithSymbol', () => {
  it('puts the sign before the symbol', () => {
    expect(formatCentsWithSymbol(1234)).toBe('$12.34');
    expect(formatCentsWithSymbol(-329)).toBe('-$3.29');
  });
});


describe('safe money parsing', () => {
  it('rejects amounts whose cents are nonfinite or unsafe integers', () => {
    for (const amount of ['9'.repeat(400), '90071992547409.92']) {
      expect(() => parseAmountToCents(amount)).toThrow(RangeError);
    }
  });
});

describe('statementDateFor', () => {
  it.each([
    [2024, 2, 29, '2024-02-29'], [2024, 2, 30, '2024-02-29'], [2024, 2, 31, '2024-02-29'],
    [2025, 2, 29, '2025-02-28'], [2025, 2, 30, '2025-02-28'], [2025, 2, 31, '2025-02-28'],
    [2025, 4, 29, '2025-04-29'], [2025, 4, 30, '2025-04-30'], [2025, 4, 31, '2025-04-30'],
    [2025, 1, 31, '2025-01-31'], [2025, 12, 1, '2025-12-01'],
  ])('%i-%i day %i falls on %s', (year, month, day, expected) => {
    expect(statementDateFor(year, month, day)).toBe(expected);
  });
});

describe('closedCycleCard', () => {
  const card = { historyName: 'Visa', historyStatementDay: 15, historyAppliedAt: 1000 };
  it('uses retrospective values only for cycles closed by the time they were saved', () => {
    expect(closedCycleCard(card, 999, 'Amex')).toEqual({ name: 'Visa', statementDay: 15 });
    expect(closedCycleCard(card, 1000, 'Amex')).toEqual({ name: 'Visa', statementDay: 15 });
    expect(closedCycleCard(card, 1001, 'Amex')).toEqual({ name: 'Amex', statementDay: null });
  });
  it('falls back to the snapshot and an unknown day without a retrospective save or card', () => {
    expect(closedCycleCard({ historyName: null, historyStatementDay: null, historyAppliedAt: null }, 5, 'Amex')).toEqual({ name: 'Amex', statementDay: null });
    expect(closedCycleCard(undefined, 5, null)).toEqual({ name: null, statementDay: null });
  });
});
