import type { Card, CycleGroup, Member } from '../types';

/** Money is integer cents everywhere. Floats never hold money. */

export const MAX_AMOUNT_CENTS = 100_000_000;

const CLEAN = /[$,\s]/g;

export function parseAmountToCents(input: string): number {
  const cleaned = String(input).replace(CLEAN, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) {
    throw new RangeError(`Not a valid amount: ${JSON.stringify(input)}`);
  }

  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;
  const [intPart, fracPart = ''] = body.split('.');

  // Parse the decimal string directly instead of multiplying a float by
  // 100: floats can't represent values like 1.005 exactly, so scaling
  // loses precision right where rounding needs it most. Three digits of
  // fraction: two become cents, the third decides the rounding.
  const frac = (fracPart + '000').slice(0, 3);
  let cents = Number(intPart || '0') * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1; // half away from zero

  if (!Number.isSafeInteger(cents)) throw new RangeError('Amount is too large to represent in cents.');

  if (cents === 0) return 0; // never return a signed zero
  return negative ? -cents : cents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatCentsWithSymbol(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${formatCents(Math.abs(cents))}`;
}

interface AnalyticsTransaction {
  amountCents: number;
  category: string;
  date: string; // YYYY-MM-DD
}

interface AnalyticsStats {
  /** Purchases plus signed refunds. Can go negative in a refund-heavy period. */
  netSpending: number;
  /** Positive transactions only. */
  grossPurchases: number;
  /** Absolute value of negative transactions. */
  refunds: number;
  /** Signed net total per YYYY-MM. */
  monthTotals: Record<string, number>;
  /** Gross purchases per category; refund transactions are excluded, not category. */
  categoryTotals: Record<string, number>;
}

/** Formats a `YYYY-MM` key as e.g. "Jun 2024" — unambiguous across years. */
export function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  // Construct with explicit local-time components (not Date.parse on an ISO
  // string) so a negative UTC offset can't roll the month back a day.
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** Axis ticks in whole cents, including both ends and omitting rounded duplicates. */
export function computeYAxisTicks(min: number, max: number, tickCount = 4): number[] {
  const step = (max - min) / tickCount;
  return [...new Set(Array.from({ length: tickCount + 1 }, (_, i) => Math.round(min + step * i) || 0))];
}

/** Calendar date (YYYY-MM-DD) a cycle was closed on, in local time. */
export function closedDateOf(closedAtMs: number): string {
  const d = new Date(closedAtMs);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Statement date (YYYY-MM-DD) for a 1-based month; days 29-31 clamp to a shorter month's last day. */
export function statementDateFor(year: number, month: number, day: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/**
 * Card label and statement day shown for a closed cycle. Retrospective values apply only to
 * cycles closed by the time they were saved; later cycles keep their snapshot and an unknown day.
 */
export function closedCycleCard(
  card: { historyName: string | null; historyStatementDay: number | null; historyAppliedAt: number | null } | undefined,
  cycleClosedAt: number,
  snapshotName: string | null,
): { name: string | null; statementDay: number | null } {
  const applies = card?.historyAppliedAt != null && cycleClosedAt <= card.historyAppliedAt;
  return applies
    ? { name: card!.historyName ?? snapshotName, statementDay: card!.historyStatementDay }
    : { name: snapshotName, statementDay: null };
}

const dayLabel = (iso: string, withYear: boolean) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear && { year: 'numeric' }) });
};

/** "Sep 16–Oct 15, 2026"; both years only when the span crosses one. */
export function formatDateSpan(start: string, end: string): string {
  if (start === end) return dayLabel(end, true);
  return `${dayLabel(start, start.slice(0, 4) !== end.slice(0, 4))}–${dayLabel(end, true)}`;
}

/**
 * History label for one payer/card group. No statement period is stored with a cycle, so the
 * period is the labeled expense-date span; a statement day is never turned into a period.
 */
export function cycleGroupLabel(
  group: CycleGroup, cycleClosedAt: number, members: Member[], cards: Card[],
): { label: string; statementDay: number | null } {
  const card = cards.find((c) => c.id === group.cardId);
  const shown = closedCycleCard(card, cycleClosedAt, group.cardNameSnapshot);
  const payer = members.find((m) => m.id === group.payerId)?.displayName ?? 'Unknown member';
  const cardName = shown.name ?? card?.name ?? (group.cardId ? 'Archived card' : 'No card');
  return {
    label: `${payer} · ${cardName} · expenses ${formatDateSpan(group.dateStart, group.dateEnd)}`,
    statementDay: shown.statementDay,
  };
}

const byText = (a: string | null, b: string | null) => ((a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0);

/** Payer/card groups of expenses, in the server's cycleGroups order: most expenses, earliest, payer, card. */
export function cycleGroupsOf(
  transactions: Array<{ payerId: string; cardId: string | null; cardNameSnapshot: string | null; date: string }>,
): CycleGroup[] {
  const groups = new Map<string, CycleGroup>();
  for (const tx of transactions) {
    const key = JSON.stringify([tx.payerId, tx.cardId, tx.cardNameSnapshot]);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { payerId: tx.payerId, cardId: tx.cardId, cardNameSnapshot: tx.cardNameSnapshot, dateStart: tx.date, dateEnd: tx.date, count: 1 });
      continue;
    }
    group.count += 1;
    if (tx.date < group.dateStart) group.dateStart = tx.date;
    if (tx.date > group.dateEnd) group.dateEnd = tx.date;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || byText(a.dateStart, b.dateStart)
    || byText(a.payerId, b.payerId) || byText(a.cardId, b.cardId));
}

/** The saved cycle name, else the History label of its first payer/card group. */
export function cycleName(
  name: string | null, groups: CycleGroup[], closedAt: number, members: Member[], cards: Card[],
): string {
  return name ?? (groups[0] ? cycleGroupLabel(groups[0], closedAt, members, cards).label : 'No expenses');
}

/** Stable cycle label like "May 2024", derived from closedAt. Reuses
 * formatMonthLabel so cycle and analytics month formatting never drift. */
export function cycleMonthLabel(closedAtMs: number): string {
  const d = new Date(closedAtMs);
  const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return formatMonthLabel(monthKey);
}

/**
 * Full closed date per cycle, id -> "YYYY-MM-DD". When two or more cycles
 * in the input share a closed date, appends " (#N)" in input order so nothing
 * in a rendered list is ever ambiguous.
 */
export function disambiguatedClosedDates(
  cycles: Array<{ id: string; closedAt: number }>,
): Record<string, string> {
  const counts: Record<string, number> = {};
  cycles.forEach((cy) => {
    const d = closedDateOf(cy.closedAt);
    counts[d] = (counts[d] || 0) + 1;
  });

  const seen: Record<string, number> = {};
  const result: Record<string, string> = {};
  cycles.forEach((cy) => {
    const d = closedDateOf(cy.closedAt);
    if (counts[d] <= 1) {
      result[cy.id] = d;
      return;
    }
    seen[d] = (seen[d] || 0) + 1;
    result[cy.id] = `${d} (#${seen[d]})`;
  });
  return result;
}

interface CycleTransactionSummary {
  count: number;
  totalCents: number;
  /** YYYY-MM-DD, or null when the cycle has no transactions. */
  dateStart: string | null;
  dateEnd: string | null;
}

/** Cycle total, transaction count, and date range — derived from the
 * cycle's own transactions, not from closedAt (when it was closed, which
 * can lag well behind when the spending happened). */
export function summarizeCycleTransactions(
  transactions: Array<{ amountCents: number; date: string }>,
): CycleTransactionSummary {
  if (transactions.length === 0) return { count: 0, totalCents: 0, dateStart: null, dateEnd: null };

  let totalCents = 0;
  let dateStart = transactions[0].date;
  let dateEnd = transactions[0].date;
  for (const tx of transactions) {
    totalCents += tx.amountCents;
    if (tx.date < dateStart) dateStart = tx.date;
    if (tx.date > dateEnd) dateEnd = tx.date;
  }
  return { count: transactions.length, totalCents, dateStart, dateEnd };
}

export function aggregateAnalytics(transactions: AnalyticsTransaction[]): AnalyticsStats {
  const monthTotals: Record<string, number> = {};
  const categoryTotals: Record<string, number> = {};
  let netSpending = 0;
  let grossPurchases = 0;
  let refunds = 0;

  transactions.forEach((tx) => {
    netSpending += tx.amountCents;

    const month = tx.date.substring(0, 7);
    monthTotals[month] = (monthTotals[month] || 0) + tx.amountCents;

    if (tx.amountCents >= 0) {
      grossPurchases += tx.amountCents;
      categoryTotals[tx.category] = (categoryTotals[tx.category] || 0) + tx.amountCents;
    } else {
      refunds += -tx.amountCents;
    }
  });

  return { netSpending, grossPurchases, refunds, monthTotals, categoryTotals };
}
