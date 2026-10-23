import { describe, it, expect } from 'vitest';
import { presentFilterValues, isDateInRange } from '../src/lib/filters';

describe('presentFilterValues', () => {
  it('collects only the values the rows contain, and their date bounds', () => {
    const present = presentFilterValues([
      { date: '2026-03-05', category: 'Travel', payerId: 'm1', cardId: 'c1' },
      { date: '2026-02-01', category: 'Food', payerId: 'm1', cardId: null },
      { date: null, category: null, payerId: null, cardId: null },
    ]);
    expect([...present.categories]).toEqual(['Travel', 'Food']);
    expect([...present.payerIds]).toEqual(['m1']);
    expect([...present.cardIds]).toEqual(['c1']);
    expect(present.minDate).toBe('2026-02-01');
    expect(present.maxDate).toBe('2026-03-05');
  });

  it('has no date bounds without rows', () => {
    const present = presentFilterValues([]);
    expect(present.minDate).toBeUndefined();
    expect(present.maxDate).toBeUndefined();
  });
});

describe('isDateInRange', () => {
  it('accepts a cleared date and dates inside the bounds only', () => {
    expect(isDateInRange('', '2026-02-01', '2026-03-05')).toBe(true);
    expect(isDateInRange('2026-02-01', '2026-02-01', '2026-03-05')).toBe(true);
    expect(isDateInRange('2026-01-31', '2026-02-01', '2026-03-05')).toBe(false);
    expect(isDateInRange('2026-03-06', '2026-02-01', '2026-03-05')).toBe(false);
  });
});
