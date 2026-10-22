import { describe, it, expect } from 'vitest';
import {
  closedDateOf,
  cycleMonthLabel,
  disambiguatedClosedDates,
  summarizeCycleTransactions,
  formatDateSpan,
  cycleGroupLabel,
  cycleGroupsOf,
  cycleName,
} from '../src/lib/money';
import type { Card, CycleGroup, Member } from '../src/types';

// Noon UTC keeps the calendar date stable across any real-world local
// timezone offset (-12..+14), so these tests aren't flaky by runner TZ.
const MAY_14_2024 = Date.UTC(2024, 4, 14, 12, 0, 0);
const MAY_14_2024_LATER = Date.UTC(2024, 4, 14, 18, 0, 0);
const MAY_15_2024 = Date.UTC(2024, 4, 15, 12, 0, 0);
const JUN_1_2024 = Date.UTC(2024, 5, 1, 12, 0, 0);

describe('closedDateOf', () => {
  it('formats an epoch-ms timestamp as YYYY-MM-DD', () => {
    expect(closedDateOf(MAY_14_2024)).toBe('2024-05-14');
  });
});

describe('cycleMonthLabel', () => {
  it('renders a stable "Mon YYYY" label from closedAt', () => {
    expect(cycleMonthLabel(MAY_14_2024)).toBe('May 2024');
  });

  it('differs across month boundaries', () => {
    expect(cycleMonthLabel(JUN_1_2024)).toBe('Jun 2024');
  });
});

describe('disambiguatedClosedDates', () => {
  it('leaves a single cycle on a given date unsuffixed', () => {
    const result = disambiguatedClosedDates([{ id: 'a', closedAt: MAY_14_2024 }]);
    expect(result).toEqual({ a: '2024-05-14' });
  });

  it('numbers cycles that share a closed date, in input order', () => {
    const result = disambiguatedClosedDates([
      { id: 'a', closedAt: MAY_14_2024 },
      { id: 'b', closedAt: MAY_14_2024_LATER },
    ]);
    expect(result).toEqual({
      a: '2024-05-14 (#1)',
      b: '2024-05-14 (#2)',
    });
  });

  it('does not suffix cycles on different dates', () => {
    const result = disambiguatedClosedDates([
      { id: 'a', closedAt: MAY_14_2024 },
      { id: 'b', closedAt: MAY_15_2024 },
    ]);
    expect(result).toEqual({
      a: '2024-05-14',
      b: '2024-05-15',
    });
  });

  it('handles three-way same-day collisions', () => {
    const result = disambiguatedClosedDates([
      { id: 'a', closedAt: MAY_14_2024 },
      { id: 'b', closedAt: MAY_14_2024 },
      { id: 'c', closedAt: MAY_14_2024_LATER },
    ]);
    expect(result).toEqual({
      a: '2024-05-14 (#1)',
      b: '2024-05-14 (#2)',
      c: '2024-05-14 (#3)',
    });
  });
});

describe('summarizeCycleTransactions', () => {
  it('returns zeros and nulls for an empty cycle', () => {
    expect(summarizeCycleTransactions([])).toEqual({
      count: 0, totalCents: 0, dateStart: null, dateEnd: null,
    });
  });

  it('sums totals, counts transactions, and finds the date range', () => {
    const result = summarizeCycleTransactions([
      { amountCents: 2000, date: '2024-05-10' },
      { amountCents: 500, date: '2024-05-02' },
      { amountCents: -300, date: '2024-05-20' },
    ]);
    expect(result).toEqual({
      count: 3, totalCents: 2200, dateStart: '2024-05-02', dateEnd: '2024-05-20',
    });
  });

  it('handles a single transaction as both start and end of the range', () => {
    const result = summarizeCycleTransactions([{ amountCents: 1000, date: '2024-05-10' }]);
    expect(result).toEqual({
      count: 1, totalCents: 1000, dateStart: '2024-05-10', dateEnd: '2024-05-10',
    });
  });
});

describe('formatDateSpan', () => {
  it('shows the year once when both ends share it', () => {
    expect(formatDateSpan('2026-09-16', '2026-10-15')).toBe('Sep 16–Oct 15, 2026');
  });

  it('shows both years across a year boundary', () => {
    expect(formatDateSpan('2025-12-16', '2026-01-15')).toBe('Dec 16, 2025–Jan 15, 2026');
  });

  it('shows a single day once', () => {
    expect(formatDateSpan('2026-10-15', '2026-10-15')).toBe('Oct 15, 2026');
  });
});

describe('cycleGroupLabel', () => {
  const CLOSED = 2000;
  const members: Member[] = [
    { id: 'm1', displayName: 'Hugo', role: 'owner', sortOrder: 0, archivedAt: null },
    { id: 'm2', displayName: 'Sam', role: 'member', sortOrder: 1, archivedAt: 1500 },
  ];
  const card = (over: Partial<Card>): Card => ({
    id: 'c1', memberId: 'm1', name: 'Visa Infinite', archived: 0, sortOrder: 0, statementDay: 20,
    historyName: null, historyStatementDay: null, historyAppliedAt: null, ...over,
  });
  const group = (over: Partial<CycleGroup>): CycleGroup => ({
    payerId: 'm1', cardId: 'c1', cardNameSnapshot: 'Visa', dateStart: '2026-09-16', dateEnd: '2026-10-15', count: 3, ...over,
  });

  it('names payer, stored card snapshot and the labeled expense span, never the live card name', () => {
    expect(cycleGroupLabel(group({}), CLOSED, members, [card({})]))
      .toEqual({ label: 'Hugo · Visa · expenses Sep 16–Oct 15, 2026', statementDay: null });
  });

  it('reads no-card expenses as No card', () => {
    expect(cycleGroupLabel(group({ cardId: null, cardNameSnapshot: null }), CLOSED, members, []).label)
      .toBe('Hugo · No card · expenses Sep 16–Oct 15, 2026');
  });

  it('uses a retrospective name and statement day only for cycles closed by then', () => {
    const renamed = card({ historyName: 'Visa Travel', historyStatementDay: 15, historyAppliedAt: CLOSED });
    expect(cycleGroupLabel(group({}), CLOSED, members, [renamed]))
      .toEqual({ label: 'Hugo · Visa Travel · expenses Sep 16–Oct 15, 2026', statementDay: 15 });
    expect(cycleGroupLabel(group({}), CLOSED + 1, members, [renamed]))
      .toEqual({ label: 'Hugo · Visa · expenses Sep 16–Oct 15, 2026', statementDay: null });
  });

  it('keeps archived members and archived or removed cards readable', () => {
    expect(cycleGroupLabel(group({ payerId: 'm2', cardId: 'c2', cardNameSnapshot: 'Old Amex' }), CLOSED, members,
      [card({ id: 'c2', memberId: 'm2', archived: 1, name: 'Amex' })]).label)
      .toBe('Sam · Old Amex · expenses Sep 16–Oct 15, 2026');
    expect(cycleGroupLabel(group({ cardId: null, cardNameSnapshot: 'Deleted card' }), CLOSED, members, []).label)
      .toBe('Hugo · Deleted card · expenses Sep 16–Oct 15, 2026');
    expect(cycleGroupLabel(group({ payerId: 'gone' }), CLOSED, members, [card({})]).label)
      .toBe('Unknown member · Visa · expenses Sep 16–Oct 15, 2026');
  });

  it('reads a card with no row and no snapshot as Archived card, not No card', () => {
    expect(cycleGroupLabel(group({ cardId: 'c9', cardNameSnapshot: null }), CLOSED, members, []).label)
      .toBe('Hugo · Archived card · expenses Sep 16–Oct 15, 2026');
  });

  it('keeps two cycles with identical group labels distinct by id and closing suffix', () => {
    const cycles = [{ id: 'a', closedAt: MAY_14_2024 }, { id: 'b', closedAt: MAY_14_2024_LATER }];
    const [labelA, labelB] = cycles.map((cy) => cycleGroupLabel(group({}), cy.closedAt, members, [card({})]).label);
    expect(labelA).toBe(labelB);
    expect(disambiguatedClosedDates(cycles)).toEqual({ a: '2024-05-14 (#1)', b: '2024-05-14 (#2)' });
  });
});

describe('cycleName', () => {
  const members: Member[] = [
    { id: 'm1', displayName: 'Hugo', role: 'owner', sortOrder: 0, archivedAt: null },
    { id: 'm2', displayName: 'Sam', role: 'member', sortOrder: 1, archivedAt: null },
  ];
  const tx = (payerId: string, cardId: string | null, date: string) => ({ payerId, cardId, cardNameSnapshot: cardId && 'Visa', date });

  it('groups open expenses like the server cycle list: most expenses, then earliest, then payer and card', () => {
    expect(cycleGroupsOf([
      tx('m2', 'c2', '2026-10-02'), tx('m1', 'c1', '2026-10-05'), tx('m1', 'c1', '2026-09-20'), tx('m1', null, '2026-09-01'),
    ])).toEqual([
      { payerId: 'm1', cardId: 'c1', cardNameSnapshot: 'Visa', dateStart: '2026-09-20', dateEnd: '2026-10-05', count: 2 },
      { payerId: 'm1', cardId: null, cardNameSnapshot: null, dateStart: '2026-09-01', dateEnd: '2026-09-01', count: 1 },
      { payerId: 'm2', cardId: 'c2', cardNameSnapshot: 'Visa', dateStart: '2026-10-02', dateEnd: '2026-10-02', count: 1 },
    ]);
  });

  it('defaults to the first group label History already shows, and No expenses when empty', () => {
    const groups = cycleGroupsOf([tx('m1', 'c1', '2026-09-16'), tx('m1', 'c1', '2026-10-15')]);
    expect(cycleName(null, groups, 2000, members, [])).toBe('Hugo · Visa · expenses Sep 16–Oct 15, 2026');
    expect(cycleName(null, [], 2000, members, [])).toBe('No expenses');
  });

  it('prefers a saved name', () => {
    expect(cycleName('Japan trip', cycleGroupsOf([tx('m1', 'c1', '2026-09-16')]), 2000, members, [])).toBe('Japan trip');
  });
});
