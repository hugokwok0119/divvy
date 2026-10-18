import type { SplitType, SplitRule } from './settlement';

export interface LegacyTx {
  id: string;
  date: string;
  store: string;
  amount: number;
  category: string;
  payerId: string;
  cardName: string;
  splitType: string;
  customSplit?: Record<string, number>;
  isStarred?: boolean;
  favoriteName?: string;
}

const LEGACY_MEMBER_IDS = new Set(['user_1', 'user_2']);

/**
 * Maps prototype split values onto the three supported types.
 *   shared            -> equal
 *   custom            -> custom, percentages from customSplit
 *   <member id>       -> single
 *   payer_only        -> single, the payer  (no rows use this)
 *   partner_only      -> equal across everyone but the payer (no rows use this)
 */
export function normalizeSplit(tx: LegacyTx): { splitType: SplitType; rule: SplitRule | null } {
  if (tx.splitType === 'shared') return { splitType: 'equal', rule: null };
  if (tx.splitType === 'custom') {
    return { splitType: 'custom', rule: { percentages: tx.customSplit ?? {} } };
  }
  if (tx.splitType === 'payer_only') {
    return { splitType: 'single', rule: { memberId: tx.payerId } };
  }
  if (LEGACY_MEMBER_IDS.has(tx.splitType)) {
    return { splitType: 'single', rule: { memberId: tx.splitType } };
  }
  // partner_only and anything unrecognised fall back to an equal split, which is
  // what the prototype did. No row in the real dump reaches this branch.
  return { splitType: 'equal', rule: null };
}

/**
 * The two cycles overlap on 2024-06-09. Membership is recovered from the stored
 * totalSpend snapshots: of the eight ways to divide the three transactions on
 * that date, only this one reproduces both totals to the cent.
 */
export const CYCLE_BOUNDARY_DATE = '2024-06-09';
export const CYCLE_A_EXTRA_STORES = ['West Point Dental Clinic', 'Uber'];

export function assignCycle(tx: LegacyTx): 'A' | 'B' {
  if (tx.date < CYCLE_BOUNDARY_DATE) return 'A';
  if (tx.date === CYCLE_BOUNDARY_DATE && CYCLE_A_EXTRA_STORES.includes(tx.store)) return 'A';
  return 'B';
}
