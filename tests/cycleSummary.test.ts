import { describe, expect, it } from 'vitest';
import { buildCycleSummary, extraCentMembers, summaryFileName } from '../src/lib/cycleSummary';
import { computeSettlement, computeShares, type SplitRule, type SplitType } from '../src/lib/settlement';
import { memberColorAt } from '../src/lib/memberColors';
import { percentagesFromAmounts } from '../src/lib/percentages';
import type { Cycle, Member, Transaction } from '../src/types';

const member = (id: string, archivedAt: number | null = null): Member =>
  ({ id, displayName: id.toUpperCase(), role: 'member', sortOrder: 0, archivedAt });

const tx = (
  id: string, date: string, amountCents: number, payerId: string,
  splitType: SplitType, rule: SplitRule | null, roster: string[],
): Transaction => ({
  id, date, amountCents, payerId, splitType,
  store: `Store ${id}`, favoriteName: null, category: 'Other', cardId: null, cardNameSnapshot: null,
  splitRuleJson: rule ? JSON.stringify(rule) : null,
  splitSharesJson: JSON.stringify(computeShares(amountCents, splitType, rule, roster)),
  cycleId: 'c1', isStarred: 0, updatedAt: 0, expenseId: id, hasBeenApproved: true, lastEditedAt: null,
  parentExpenseId: null, revision: 1, editedByMemberId: null, editedByName: null, source: 'manual',
  sourceFileId: null, sourceFileName: null, reviewNote: null,
});

const cycle = (status: 'closed' | 'settled'): Cycle => ({
  id: 'c1', status, settlementJson: null, closedByMemberId: null, closedByName: null,
  closingSnapshotJson: null, closedAt: new Date(2026, 9, 6, 12).getTime(), settledAt: null,
});

const settlementFor = (rows: Transaction[], roster: string[]) => computeSettlement(
  rows.map((r) => ({ payerId: r.payerId, amountCents: r.amountCents, shares: JSON.parse(r.splitSharesJson) })),
  roster,
);

describe('extraCentMembers', () => {
  const abc = ['a', 'b', 'c'];
  it('marks who got the leftover cent of an equal split', () => {
    expect(extraCentMembers(tx('t', '2026-10-03', 1000, 'a', 'equal', null, abc))).toEqual(['a']);
    expect(extraCentMembers(tx('t', '2026-10-03', 6001, 'a', 'equal', null, ['a', 'b', 'c', 'd']))).toHaveLength(1);
  });
  it('marks who got the leftover cent of a custom split', () => {
    // 7¢ at 60/40 is 4.2 / 2.8: floors 4 / 2, and the leftover cent goes to b.
    const row = tx('t', '2026-10-03', 7, 'a', 'custom', { percentages: { a: 60, b: 40 } }, ['a', 'b']);
    expect(JSON.parse(row.splitSharesJson)).toEqual({ a: 4, b: 3 });
    expect(extraCentMembers(row)).toEqual(['b']);
  });
  it('never marks a single split or an exact split', () => {
    expect(extraCentMembers(tx('t', '2026-10-03', 1001, 'a', 'single', { memberId: 'a' }, abc))).toEqual([]);
    expect(extraCentMembers(tx('t', '2026-10-03', 18900, 'a', 'equal', null, ['a', 'b', 'c', 'd']))).toEqual([]);
  });
  it('does not mark exact amount-based custom splits despite float percentages', () => {
    // Amount mode saves 1¢/2¢ of 3¢ as {33.333…, 66.666…}; 3 × 66.666…/100 is 1.999… in floats.
    const row = tx('t', '2026-10-03', 3, 'a', 'custom', { percentages: percentagesFromAmounts({ a: 1, b: 2 }) }, ['a', 'b']);
    expect(JSON.parse(row.splitSharesJson)).toEqual({ a: 1, b: 2 });
    expect(extraCentMembers(row)).toEqual([]);
  });
  it('compares absolute values for refunds', () => {
    expect(extraCentMembers(tx('t', '2026-10-03', -1000, 'a', 'equal', null, abc))).toEqual(['a']);
  });
});

describe('buildCycleSummary', () => {
  const members = ['m1', 'm2', 'm3', 'm4'].map((id) => member(id)).concat(member('m5', 123), member('m6'));
  const five = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const rows = [
    tx('t1', '2026-10-05', 7218, 'm2', 'equal', null, five),
    tx('t2', '2026-10-03', 6001, 'm1', 'equal', null, ['m1', 'm2', 'm3', 'm4']),
    tx('t3', '2026-10-03', 1000, 'm5', 'equal', null, ['m1', 'm2', 'm5']),
    tx('t4', '2026-10-04', -900, 'm3', 'equal', null, ['m1', 'm2', 'm3']),
  ];
  const build = (status: 'closed' | 'settled', settlement = settlementFor(rows, five)) =>
    buildCycleSummary({ householdName: 'Trip', cycle: cycle(status), transactions: rows, settlement, members });

  it('lists only involved members in member order, archived ones included', () => {
    const s = build('closed');
    expect(s.people.map((p) => p.id)).toEqual(five);
    expect(s.people[4].color).toBe(memberColorAt(4));
    expect(s.people[4].name).toBe('M5');
  });

  it('adds up to the cent, including a refund row', () => {
    const s = build('closed');
    const sum = (k: 'paidCents' | 'shareCents' | 'netCents') => s.people.reduce((n, p) => n + p[k], 0);
    expect(s.totalCents).toBe(7218 + 6001 + 1000 - 900);
    expect(sum('shareCents')).toBe(s.totalCents);
    expect(sum('paidCents')).toBe(s.totalCents);
    expect(sum('netCents')).toBe(0);
  });

  it('matches the settlement balances for closed and settled cycles', () => {
    for (const status of ['closed', 'settled'] as const) {
      const settlement = settlementFor(rows, five);
      const s = build(status, settlement);
      s.people.forEach((p) => expect(p.netCents).toBe(settlement.balances[p.id]));
      expect(s.status).toBe(status);
    }
  });

  it('orders transfers by member order of payer, then receiver', () => {
    const s = build('closed', { balances: {}, transfers: [
      { from: 'm3', to: 'm1', amountCents: 5 }, { from: 'm1', to: 'm2', amountCents: 7 },
    ] });
    expect(s.transfers).toEqual([
      { fromName: 'M1', fromColor: memberColorAt(0), toName: 'M2', amountCents: 7 },
      { fromName: 'M3', fromColor: memberColorAt(2), toName: 'M1', amountCents: 5 },
    ]);
  });

  it('sorts items oldest first, keeping input order within a day', () => {
    const s = build('closed');
    expect(s.items.map((i) => i.id)).toEqual(['t2', 't3', 't4', 't1']);
    expect(s.dateStart).toBe('2026-10-03');
    expect(s.dateEnd).toBe('2026-10-05');
    expect(s.closedDate).toBe('2026-10-06');
  });

  it('uses the favorite name and payer name', () => {
    const s = buildCycleSummary({
      householdName: 'Trip', cycle: cycle('closed'), members, settlement: { balances: {}, transfers: [] },
      transactions: [{ ...rows[0], favoriteName: 'Groceries run' }],
    });
    expect(s.items[0]).toMatchObject({ name: 'Groceries run', payerName: 'M2', payerColor: memberColorAt(1) });
  });
});

describe('summaryFileName', () => {
  it('builds a safe file name from the closed label', () => {
    expect(summaryFileName('2026-10-21')).toBe('divvy-summary-2026-10-21.jpg');
    expect(summaryFileName('2026-10-21 (#2)')).toBe('divvy-summary-2026-10-21-2.jpg');
  });
});
