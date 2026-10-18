import type { QueueItem, Transaction, QueueItemInput, SplitRule, TxPatch, ExpenseHistoryEvent } from '../types';
import { formatCents, formatCentsWithSymbol, parseAmountToCents, MAX_AMOUNT_CENTS } from '../lib/money';
import { canNormalizePercentages, customPercentagesError, sameSplitRule } from '../lib/percentages';
import { normalizeMerchantName } from '../lib/category';

export type LedgerRow =
  { kind: 'pending'; item: QueueItem } | { kind: 'approved'; item: Transaction };
export interface ExpenseDraft {
  date: string;
  store: string;
  amount: string;
  category: string;
  payerId: string;
  cardId: string;
  splitType: string;
  splitRule: SplitRule | null;
  customAllocation?: { percentages: Record<string, string>; finished?: boolean };
}
export function draftFrom(item: QueueItem | Transaction): ExpenseDraft {
  let splitRule: SplitRule | null = null;
  try {
    splitRule = item.splitRuleJson ? JSON.parse(item.splitRuleJson) : null;
  } catch {
    /* Legacy rows may contain invalid allocation JSON. */
  }
  return {
    date: item.date ?? '',
    store: item.store ?? '',
    amount: item.amountCents === null ? '' : formatCents(item.amountCents),
    category: item.category ?? '',
    payerId: item.payerId ?? '',
    cardId: item.cardId ?? '',
    splitType: item.splitType ?? '',
    splitRule,
  };
}
export function changePayer(draft: ExpenseDraft, payerId: string): ExpenseDraft {
  return {
    ...draft,
    payerId,
    cardId: payerId === draft.payerId ? draft.cardId : '',
  };
}
/** A completed request must not replace text entered while it was saving. */
export function rebaseDraft(saved: ExpenseDraft, sent: ExpenseDraft, current: ExpenseDraft): ExpenseDraft {
  return Object.fromEntries([...new Set([...Object.keys(saved), ...Object.keys(current)])]
    .map(key => [key, JSON.stringify(current[key as keyof ExpenseDraft]) === JSON.stringify(sent[key as keyof ExpenseDraft])
      ? saved[key as keyof ExpenseDraft] : current[key as keyof ExpenseDraft]])) as unknown as ExpenseDraft;
}
function sameSplit(draft: ExpenseDraft, base?: ExpenseDraft): boolean {
  return !!base && draft.splitType === base.splitType
    && sameSplitRule(draft.splitRule, base.splitRule);
}
export function patchFrom(draft: ExpenseDraft, base?: ExpenseDraft): Partial<QueueItemInput> {
  if (draft.customAllocation) throw new Error('Save or cancel the custom allocation before completing this expense.');
  if (!draft.amount.trim() && base?.amount.trim()) throw new RangeError('Enter a valid amount.');
  const amountCents = draft.amount.trim() ? parseAmountToCents(draft.amount) : null;
  if (amountCents !== null && Math.abs(amountCents) > MAX_AMOUNT_CENTS) {
    throw new RangeError('Amount must be between -1,000,000.00 and 1,000,000.00.');
  }
  const patch: Partial<QueueItemInput> = {
    date: draft.date || null,
    store: draft.store || null,
    amountCents,
    category: draft.category || null,
    payerId: draft.payerId || null,
    cardId: draft.cardId || null,
    splitType: draft.splitType || null,
    splitRule: draft.splitRule,
  };
  if (sameSplit(draft, base)) {
    delete patch.splitType;
    delete patch.splitRule;
  }
  return patch;
}
export function validateDraft(draft: ExpenseDraft, complete: boolean, base?: ExpenseDraft) {
  const patch = patchFrom(draft, base);
  if (complete && (!patch.date || !patch.store?.trim() || patch.amountCents === null
    || !patch.category || !patch.payerId || !draft.splitType)) {
    throw new Error('Fill in date, store, amount, category, payer and split before approving or saving Approved expenses.');
  }
  if (draft.splitType === 'single' && !draft.splitRule?.memberId)
    throw new Error('Choose a member for the single-person split.');
  if (draft.splitType === 'custom') {
    const percentages = draft.splitRule?.percentages ?? {};
    if (!sameSplit(draft, base)) {
      const error = customPercentagesError(percentages);
      if (error) throw new Error(error);
    } else if (complete && !canNormalizePercentages(percentages)) {
      throw new Error('Custom allocation needs at least one positive percentage.');
    }
  }
  return patch;
}
export function approvedPatch(draft: ExpenseDraft, base?: ExpenseDraft): TxPatch {
  const patch = validateDraft(draft, true, base);
  // Complete validation above narrows the nullable Pending form at this boundary.
  return {
    date: patch.date!, store: patch.store!, amountCents: patch.amountCents!,
    category: patch.category!, payerId: patch.payerId!, cardId: patch.cardId!,
    ...(patch.splitType === undefined ? {} : {
      splitType: draft.splitType as Transaction['splitType'], splitRule: draft.splitRule,
    }),
  };
}
const labels: Record<string, string> = {
  date: 'Date',
  store: 'Store',
  amountCents: 'Amount',
  category: 'Category',
  payerId: 'Payer',
  cardId: 'Card',
  splitType: 'Split',
  splitRuleJson: 'Split allocation',
  splitSharesJson: 'Shares',
  reviewNote: 'Review note',
  state: 'State',
  isStarred: 'Favorite',
  favoriteName: 'Favorite name',
  source: 'Source',
  sourceFileName: 'Source file',
  isDuplicate: 'Duplicate flag',
};
export function expenseDifferences(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  names: Record<string, string> = {},
) {
  const display = (key: string, value: unknown): string => {
    if (value == null) return 'Not set';
    if (key === 'splitSharesJson' || key === 'splitRuleJson') {
      let allocation: unknown = value;
      try { if (typeof allocation === 'string') allocation = JSON.parse(allocation); }
      catch { return 'Allocation unavailable'; }
      if (allocation === null) return 'Not set';
      if (typeof allocation !== 'object' || Array.isArray(allocation)) return 'Allocation unavailable';
      if (key === 'splitRuleJson') {
        if ('memberId' in allocation && typeof allocation.memberId === 'string')
          return names[allocation.memberId] ?? 'Former member';
        if (!Object.keys(allocation).length) return 'Not set';
        allocation = 'percentages' in allocation ? allocation.percentages : null;
      }
      if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) return 'Allocation unavailable';
      const parts = Object.entries(allocation).map(([id, amount]) => {
        if (typeof amount !== 'number' || !Number.isFinite(amount)
          || (key === 'splitSharesJson' ? !Number.isSafeInteger(amount) : amount < 0 || amount > 100)) return null;
        return `${names[id] ?? 'Former member'} ${key === 'splitSharesJson' ? formatCentsWithSymbol(amount) : `${amount}%`}`;
      });
      return parts.includes(null) ? 'Allocation unavailable' : parts.join(' · ') || 'Not set';
    }
    return key === 'amountCents' && typeof value === 'number' ? formatCents(value)
      : names[String(value)] ?? (typeof value === 'object' ? JSON.stringify(value) : String(value));
  };
  return Object.entries(labels)
    .filter(([key]) => key in after && JSON.stringify(before?.[key]) !== JSON.stringify(after[key]))
    .map(([key, field]) => ({
      field,
      before: before ? display(key, before[key]) : 'No earlier value',
      after: display(key, after[key]),
    }));
}
/** Historical snapshots stay intact; only post-approval changes appear in the editor. */
export function visibleExpenseHistory(events: ExpenseHistoryEvent[]) {
  const approvedAt = new Map<string, number>();
  for (const event of events) {
    const revision = event.before?.state === 'approved' ? event.before.revision
      : event.after.state === 'approved' || event.after.hasBeenApproved ? event.after.revision : undefined;
    if (revision !== undefined) approvedAt.set(event.expenseId, Math.min(approvedAt.get(event.expenseId) ?? Infinity, revision));
  }
  return events.filter(event => {
    const approved = event.after.hasBeenApproved || event.after.state === 'approved'
      || event.after.revision >= (approvedAt.get(event.expenseId) ?? Infinity);
    if (['edited', 'category_suggestion', 'split'].includes(event.eventType))
      return approved && expenseDifferences(event.before, event.after).length > 0;
    return approved && event.eventType !== 'imported';
  });
}
/** Advisory comparison only; the server decides whether a saved row is flagged. */
export function findMatchingTransaction(
  item: QueueItem,
  transactions: Transaction[],
): Transaction | null {
  if (item.amountCents === null || !item.date || !normalizeMerchantName(item.store ?? ''))
    return null;
  return (
    transactions.find(
      (t) =>
        t.expenseId !== item.expenseId &&
        t.amountCents === item.amountCents &&
        normalizeMerchantName(t.store) === normalizeMerchantName(item.store ?? '') &&
        Math.abs(new Date(item.date!).getTime() - new Date(t.date).getTime()) <=
          3 * 24 * 60 * 60 * 1000 &&
        (!item.payerId || t.payerId === item.payerId) &&
        (!item.cardId || t.cardId === item.cardId),
    ) ?? null
  );
}

const palette = [
  '#10b981',
  '#f97316',
  '#3b82f6',
  '#6366f1',
  '#d946ef',
  '#06b6d4',
  '#ec4899',
  '#8b5cf6',
  '#ef4444',
  '#64748b',
];
export const color = (value: string) =>
  palette[Array.from(value).reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length];

/** Ledger color per key, moving a key whose color is taken to the next unused palette color. */
export function distinctColors(keys: string[]): Record<string, string> {
  const used = new Set<string>();
  return Object.fromEntries(keys.map((key) => {
    const start = palette.indexOf(color(key));
    const free = palette.map((_, i) => palette[(start + i) % palette.length]).find((c) => !used.has(c)) ?? color(key);
    used.add(free);
    return [key, free];
  }));
}
