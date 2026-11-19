import type { Bootstrap } from '../types';

/** Who is in stays fixed once the open cycle has any Pending row or Approved expense (the server enforces it too). */
export const cycleLocked = (b: Pick<Bootstrap, 'queue' | 'transactions'>): boolean =>
  b.queue.length > 0 || b.transactions.length > 0;

/** The latest close time, or null when no cycle has closed. */
export const lastClosedAt = (b: Pick<Bootstrap, 'cycles'>): number | null =>
  b.cycles.length === 0 ? null : Math.max(...b.cycles.map((c) => c.closedAt));

/** One auto-open per group and closed cycle: a later close changes the key, a refresh does not. */
export const rosterAskKey = (b: Pick<Bootstrap, 'household' | 'cycles'>): string =>
  `${b.household.id}:${lastClosedAt(b) ?? 'none'}`;

/** The owner is asked who is in when the open cycle is empty and the roster was not saved since the last close. */
export const rosterNeedsConfirm = (b: Bootstrap): boolean => {
  if (b.me.role !== 'owner' || cycleLocked(b)) return false;
  const confirmed = b.household.rosterConfirmedAt;
  const closed = lastClosedAt(b);
  return confirmed === null || (closed !== null && confirmed < closed);
};
