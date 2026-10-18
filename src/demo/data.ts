// Pure module: no React, no DOM API, no `?url` assets. The Workers-runtime parity test loads it.
import type {
  Card, Cycle, ExpenseHistoryEvent, ExpenseSnapshot, Member, QueueItem, SplitType, Transaction,
} from '../types';
import { computeSettlement, computeShares, type SplitRule } from '../lib/settlement';
import { isDuplicateMatch } from '../lib/duplicates';
import type { DemoState, SampleResult } from './types';

export const DEMO_IDS = {
  household: 'hh_demo',
  alex: 'mem_alex',
  sam: 'mem_sam',
  visa: 'card_demo_visa',
  mastercard: 'card_demo_mc',
} as const;

const ROSTER = [DEMO_IDS.alex, DEMO_IDS.sam];
const NAMES: Record<string, string> = { [DEMO_IDS.alex]: 'Alex', [DEMO_IDS.sam]: 'Sam' };
const CARD_OF: Record<string, string> = { [DEMO_IDS.alex]: DEMO_IDS.visa, [DEMO_IDS.sam]: DEMO_IDS.mastercard };
const CARD_NAMES: Record<string, string> = { [DEMO_IDS.visa]: 'Demo Visa', [DEMO_IDS.mastercard]: 'Demo Mastercard' };
const CLOSED_MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const OPEN_MONTH = '2026-09';

/** Merchants absent from every sample, so a sample replay keeps its recorded categories. */
const CATEGORY_PREFERENCES: Record<string, string> = {
  'hollowmere hardware': 'Shopping',
  'driftpine dental': 'Health',
  'cobbleway property management': 'Rent',
};

type SampleRow = { date: string; store: string; amountCents: number; category: string };

/** mulberry32: small seeded PRNG so every build is identical. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (date: string, hourUtc: number) => Date.parse(`${date}T${String(hourUtc).padStart(2, '0')}:00:00Z`);
const titleCase = (store: string) => store.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const snapshot = (row: object, state: ExpenseSnapshot['state']) => ({ ...row, state }) as ExpenseSnapshot;

function nextMonth(month: string) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

interface Draft {
  date: string; store: string; amountCents: number; category: string;
  payerId: string; cardId: string | null; splitType: SplitType; splitRule: SplitRule | null;
}

export function buildDemoData(samples: SampleResult[]): DemoState {
  const rand = prng(20260917);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)];

  const sampleRows = samples.flatMap((s) =>
    s.status === 200 ? (s.body as { transactions: SampleRow[] }).transactions : []);
  // Frequency-weighted merchant pool; card fees ('Other') and refunds are not household spending.
  const pool = sampleRows.filter((row) => row.amountCents > 0 && row.category !== 'Other');
  const ranges = new Map<string, [number, number]>();
  for (const row of pool) {
    const [lo, hi] = ranges.get(row.store) ?? [row.amountCents, row.amountCents];
    ranges.set(row.store, [Math.min(lo, row.amountCents), Math.max(hi, row.amountCents)]);
  }

  function draft(month: string): Draft {
    const row = pick(pool);
    const [lo, hi] = ranges.get(row.store)!;
    // Fixed-price merchants (subscriptions, internet) keep their price; others vary around the observed range.
    const amountCents = lo === hi ? lo : Math.round(lo * 0.85 + rand() * (hi * 1.15 - lo * 0.85));
    const [y, m] = month.split('-').map(Number);
    const day = 1 + Math.floor(rand() * new Date(Date.UTC(y, m, 0)).getUTCDate());
    const payerId = rand() < 0.55 ? DEMO_IDS.alex : DEMO_IDS.sam;
    const other = payerId === DEMO_IDS.alex ? DEMO_IDS.sam : DEMO_IDS.alex;
    const cardId = rand() < 0.9 ? CARD_OF[payerId] : null;
    const r = rand();
    const share = pick([60, 70]);
    const [splitType, splitRule]: [SplitType, SplitRule | null] = r < 0.6 ? ['equal', null]
      : r < 0.8 ? ['single', { memberId: payerId }]
        : ['custom', { percentages: { [payerId]: share, [other]: 100 - share } }];
    return { date: `${month}-${String(day).padStart(2, '0')}`, store: titleCase(row.store), amountCents,
      category: row.category, payerId, cardId, splitType, splitRule };
  }

  /** Open and Pending rows must not look like any sample row, so imports flag only the designed matches. */
  function unmatchedDraft(month: string): Draft {
    for (;;) {
      const d = draft(month);
      if (!sampleRows.some((row) => isDuplicateMatch(d, row))) return d;
    }
  }

  let txCount = 0;
  let eventCount = 0;
  const history: ExpenseHistoryEvent[] = [];
  const event = (eventType: ExpenseHistoryEvent['eventType'], actorId: string,
    before: ExpenseSnapshot | null, after: ExpenseSnapshot) => {
    history.push({ id: `evt_demo_${String(++eventCount).padStart(4, '0')}`, expenseId: after.expenseId, eventType,
      actorMemberId: actorId, actorName: NAMES[actorId], timestamp: after.updatedAt, before, after,
      reviewNote: after.reviewNote ?? null });
  };

  /** A row that went through Pending and was approved by its payer: queue revision 1, Approved revision 2. */
  function approve(d: Draft): Transaction {
    const n = String(++txCount).padStart(4, '0');
    const expenseId = `exp_demo_${n}`;
    const splitRuleJson = d.splitRule ? JSON.stringify(d.splitRule) : null;
    const attribution = { editedByMemberId: d.payerId, editedByName: NAMES[d.payerId] };
    const pending: QueueItem = {
      expenseId, hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null, revision: 1, ...attribution,
      source: 'manual', sourceFileId: null, sourceFileName: null, reviewNote: null, splitRuleJson,
      updatedAt: at(d.date, 19), id: expenseId, date: d.date, store: d.store, amountCents: d.amountCents,
      category: d.category, payerId: d.payerId, cardId: d.cardId, splitType: d.splitType, isDuplicate: 0,
    };
    const tx: Transaction = {
      expenseId, hasBeenApproved: true, lastEditedAt: null, parentExpenseId: null, revision: 2, ...attribution,
      source: 'manual', sourceFileId: null, sourceFileName: null, reviewNote: null,
      id: `tx_demo_${n}`, cycleId: null, date: d.date, store: d.store, amountCents: d.amountCents,
      category: d.category, payerId: d.payerId, cardId: d.cardId,
      cardNameSnapshot: d.cardId ? CARD_NAMES[d.cardId] : null, splitType: d.splitType, splitRuleJson,
      splitSharesJson: JSON.stringify(computeShares(d.amountCents, d.splitType, d.splitRule, ROSTER)),
      isStarred: 0, favoriteName: null, updatedAt: at(d.date, 21),
    };
    event('approved', d.payerId, snapshot(pending, 'pending'), snapshot(tx, 'approved'));
    return tx;
  }

  const byDateDesc = (a: { date: string; id: string }, b: { date: string; id: string }) =>
    b.date.localeCompare(a.date) || a.id.localeCompare(b.id);

  const members: Member[] = [
    { id: DEMO_IDS.alex, displayName: 'Alex', role: 'owner', sortOrder: 0, archivedAt: null },
    { id: DEMO_IDS.sam, displayName: 'Sam', role: 'member', sortOrder: 1, archivedAt: null },
  ];

  const cycles: Cycle[] = [];
  const archived: Transaction[] = [];
  for (const month of CLOSED_MONTHS) {
    const cycleId = `cyc_demo_${month}`;
    const closedAt = at(`${nextMonth(month)}-01`, 18);
    const rows = Array.from({ length: 15 + Math.floor(rand() * 11) }, () => approve(draft(month)))
      .map((tx) => {
        const closed = { ...tx, cycleId, revision: tx.revision + 1, updatedAt: closedAt };
        event('closed', DEMO_IDS.alex, snapshot(tx, 'approved'), snapshot(closed, 'approved'));
        return closed;
      });
    archived.push(...rows);
    const settled = month !== CLOSED_MONTHS[CLOSED_MONTHS.length - 1];
    const settlement = computeSettlement(rows.map((tx) => ({ payerId: tx.payerId, amountCents: tx.amountCents,
      shares: JSON.parse(tx.splitSharesJson) as Record<string, number> })), ROSTER);
    cycles.push({ id: cycleId, status: settled ? 'settled' : 'closed',
      settlementJson: settled ? JSON.stringify(settlement) : null,
      closedByMemberId: DEMO_IDS.alex, closedByName: NAMES[DEMO_IDS.alex],
      // Same shape closeCycle writes: approved snapshots at the closed revision plus the public members.
      closingSnapshotJson: JSON.stringify({ transactions: rows.map((tx) => snapshot(tx, 'approved')), members }),
      closedAt, settledAt: settled ? closedAt + 3 * 24 * 60 * 60 * 1000 : null });
  }

  // The two designed matches: sample-a1 rows SAFFRONQUILL KITCHEN 2026-09-07 6500 and QUILLFERN MARKET #0042 2026-09-10 9231.
  const alexVisa = { payerId: DEMO_IDS.alex, cardId: DEMO_IDS.visa, splitType: 'equal' as const, splitRule: null };
  const open = [
    approve({ date: '2026-09-06', store: 'Saffronquill Kitchen', amountCents: 6500, category: 'Dining', ...alexVisa }),
    approve({ date: '2026-09-10', store: 'Quillfern Market #0042', amountCents: 9231, category: 'Groceries', ...alexVisa }),
    ...Array.from({ length: 10 }, () => approve(unmatchedDraft(OPEN_MONTH))),
  ];

  // Pending rows: one complete, one missing its category, one missing payer and split.
  const queueDrafts = [unmatchedDraft(OPEN_MONTH), unmatchedDraft(OPEN_MONTH), unmatchedDraft(OPEN_MONTH)];
  const queue = queueDrafts.map((d, i): QueueItem => {
    const id = `exp_demo_p${i + 1}`;
    const missingPayer = i === 2;
    return {
      expenseId: id, hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null, revision: 1,
      editedByMemberId: DEMO_IDS.alex, editedByName: NAMES[DEMO_IDS.alex], source: 'manual',
      sourceFileId: null, sourceFileName: null, reviewNote: null,
      splitRuleJson: missingPayer || !d.splitRule ? null : JSON.stringify(d.splitRule),
      updatedAt: at(d.date, 19), id, date: d.date, store: d.store, amountCents: d.amountCents,
      category: i === 1 ? null : d.category, payerId: missingPayer ? null : d.payerId,
      cardId: missingPayer ? null : d.cardId, splitType: missingPayer ? null : d.splitType, isDuplicate: 0,
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));

  const card = (id: string, memberId: string, sortOrder: number, statementDay: number): Card => ({
    id, memberId, name: CARD_NAMES[id], archived: 0, sortOrder, statementDay,
    historyName: null, historyStatementDay: null, historyAppliedAt: null,
  });

  return {
    bootstrap: {
      me: { memberId: DEMO_IDS.alex, role: 'owner' },
      household: { id: DEMO_IDS.household, name: 'Demo Household', currencyCode: 'CAD',
        timezone: 'America/Vancouver', customCategories: [] },
      members,
      cards: [card(DEMO_IDS.visa, DEMO_IDS.alex, 0, 5), card(DEMO_IDS.mastercard, DEMO_IDS.sam, 1, 20)],
      transactions: open.sort(byDateDesc),
      queue,
      cycles: cycles.sort((a, b) => b.closedAt - a.closedAt),
      categoryPreferences: { ...CATEGORY_PREFERENCES },
    },
    archived: archived.sort(byDateDesc),
    history,
  };
}
