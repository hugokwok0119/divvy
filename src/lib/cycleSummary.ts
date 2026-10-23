import type { Cycle, Member, Settlement, Transaction } from '../types';
import { closedDateOf } from './money';
import { memberColorAt } from './memberColors';

export interface SummaryPerson { id: string; name: string; color: string; paidCents: number; shareCents: number; netCents: number }
export interface SummaryItem { id: string; date: string; name: string; payerName: string; payerColor: string; amountCents: number; shares: Record<string, number>; extraCent: string[] }
export interface SummaryTransfer { fromName: string; fromColor: string; toName: string; amountCents: number }
export interface CycleSummary {
  householdName: string; status: 'closed' | 'settled'; closedDate: string;
  dateStart: string | null; dateEnd: string | null; totalCents: number;
  people: SummaryPerson[]; items: SummaryItem[]; transfers: SummaryTransfer[];
}

const UNKNOWN_COLOR = '#94a3b8';

/** Members whose stored share got one of the leftover cents when the split was not exact. */
export function extraCentMembers(
  tx: Pick<Transaction, 'amountCents' | 'splitType' | 'splitRuleJson' | 'splitSharesJson'>,
): string[] {
  if (tx.splitType === 'single') return [];
  const shares = JSON.parse(tx.splitSharesJson) as Record<string, number>;
  const weights: Record<string, number> = tx.splitType === 'custom'
    ? (JSON.parse(tx.splitRuleJson ?? '{}') as { percentages?: Record<string, number> }).percentages ?? {}
    : Object.fromEntries(Object.keys(shares).map((id) => [id, 1]));
  // Sum like distributeByWeight (positive weights, sorted ids) so float totals agree bit for bit.
  const total = Object.keys(weights).filter((id) => weights[id] > 0).sort().reduce((a, id) => a + weights[id], 0);
  if (total <= 0) return [];
  // Every share starts at the floor and leftover cents add 1 each. The epsilon stops float
  // percentages from amount mode (1.9999…) reading as an uneven split.
  return Object.keys(shares).filter((id) =>
    Math.abs(shares[id]) > Math.floor((Math.abs(tx.amountCents) * (weights[id] ?? 0)) / total + 1e-9));
}

export function buildCycleSummary(input: {
  householdName: string; cycle: Cycle; transactions: Transaction[]; settlement: Settlement; members: Member[];
}): CycleSummary {
  const { members, transactions } = input;
  const index = (id: string) => {
    const i = members.findIndex((m) => m.id === id);
    return i < 0 ? members.length : i;
  };
  const nameOf = (id: string) => members.find((m) => m.id === id)?.displayName ?? 'Unknown';
  const colorOf = (id: string) => {
    const i = members.findIndex((m) => m.id === id);
    return i < 0 ? UNKNOWN_COLOR : memberColorAt(i);
  };

  const paid: Record<string, number> = {};
  const share: Record<string, number> = {};
  const items: SummaryItem[] = transactions
    .map((tx, order) => ({ tx, order }))
    .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.order - b.order)
    .map(({ tx }) => {
      const shares = JSON.parse(tx.splitSharesJson) as Record<string, number>;
      paid[tx.payerId] = (paid[tx.payerId] ?? 0) + tx.amountCents;
      for (const [id, cents] of Object.entries(shares)) share[id] = (share[id] ?? 0) + cents;
      return {
        id: tx.id, date: tx.date, name: tx.favoriteName ?? tx.store,
        payerName: nameOf(tx.payerId), payerColor: colorOf(tx.payerId), amountCents: tx.amountCents, shares, extraCent: extraCentMembers(tx),
      };
    });

  const people = [...new Set([...Object.keys(paid), ...Object.keys(share)])]
    .sort((a, b) => index(a) - index(b))
    .map((id) => {
      const paidCents = paid[id] ?? 0;
      const shareCents = share[id] ?? 0;
      return { id, name: nameOf(id), color: colorOf(id), paidCents, shareCents, netCents: paidCents - shareCents };
    });

  const transfers = [...input.settlement.transfers]
    .sort((a, b) => index(a.from) - index(b.from) || index(a.to) - index(b.to))
    .map((t) => ({ fromName: nameOf(t.from), fromColor: colorOf(t.from), toName: nameOf(t.to), amountCents: t.amountCents }));

  return {
    householdName: input.householdName,
    status: input.cycle.status,
    closedDate: closedDateOf(input.cycle.closedAt),
    dateStart: items[0]?.date ?? null,
    dateEnd: items[items.length - 1]?.date ?? null,
    totalCents: items.reduce((sum, item) => sum + item.amountCents, 0),
    people, items, transfers,
  };
}

/** `2026-10-21 (#2)` → `divvy-summary-2026-10-21-2.jpg` */
export const summaryFileName = (closedLabel: string) =>
  `divvy-summary-${closedLabel.replace(/ \(#(\d+)\)$/, '-$1')}.jpg`;
