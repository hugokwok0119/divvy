import { normalizeMerchantName } from './category';

/** Server-authoritative duplicate-detection window for the bulk queue import. */
export const DUPLICATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // ponytail: fixed 3 days; make a household setting if 3 is ever wrong for someone.

export interface DuplicateCandidate {
  date: string | null;
  store: string | null;
  amountCents: number | null;
  payerId?: string | null;
  cardId?: string | null;
}

/**
 * Advisory duplicate match: exact signed amount, normalized merchant name,
 * and a date within DUPLICATE_WINDOW_MS. When both sides name a payer or a
 * card and they disagree, it's not a match — that's the one place payer/card
 * narrow the decision, since most queue rows don't have them yet.
 */
export function isDuplicateMatch(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  if (a.amountCents == null || b.amountCents == null || a.amountCents !== b.amountCents) return false;
  if (!a.date || !b.date) return false;
  if (Math.abs(new Date(a.date).getTime() - new Date(b.date).getTime()) > DUPLICATE_WINDOW_MS) return false;

  const storeA = normalizeMerchantName(a.store ?? '');
  const storeB = normalizeMerchantName(b.store ?? '');
  if (!storeA || storeA !== storeB) return false;

  if (a.payerId && b.payerId && a.payerId !== b.payerId) return false;
  if (a.cardId && b.cardId && a.cardId !== b.cardId) return false;
  return true;
}
