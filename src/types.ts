export type SplitType = 'equal' | 'custom' | 'single';

export interface SplitRule {
  memberId?: string;
  percentages?: Record<string, number>;
}

export interface Member {
  id: string;
  displayName: string;
  role: 'owner' | 'member';
  sortOrder: number;
  archivedAt: number | null;
}

export interface Card {
  id: string;
  memberId: string;
  name: string;
  archived: number;
  sortOrder: number;
  statementDay: number | null;
  historyName: string | null;
  historyStatementDay: number | null;
  /** Retrospective values apply only to cycles closed at or before this time (see closedCycleCard). */
  historyAppliedAt: number | null;
}

/** A manual calendar tick, keyed by household, month and reminder identity (`card:<cardId>` or `rent`). */
export interface ReminderCompletion {
  month: string;
  reminderId: string;
  completedByMemberId: string | null;
  completedAt: number;
}

export interface Transaction {
  expenseId: string;
  hasBeenApproved: boolean;
  lastEditedAt: number | null;
  parentExpenseId: string | null;
  revision: number;
  editedByMemberId: string | null;
  editedByName: string | null;
  source: 'manual' | 'csv' | 'image' | null;
  sourceFileId: string | null;
  sourceFileName: string | null;
  reviewNote: string | null;

  id: string;
  cycleId: string | null;
  date: string;
  store: string;
  amountCents: number;
  category: string;
  payerId: string;
  cardId: string | null;
  cardNameSnapshot: string | null;
  splitType: SplitType;
  splitRuleJson: string | null;
  splitSharesJson: string;
  isStarred: number;
  favoriteName: string | null;
  updatedAt: number;
}

export interface QueueItem {
  expenseId: string;
  hasBeenApproved: boolean;
  lastEditedAt: number | null;
  parentExpenseId: string | null;
  revision: number;
  editedByMemberId: string | null;
  editedByName: string | null;
  source: 'manual' | 'csv' | 'image' | null;
  sourceFileId: string | null;
  sourceFileName: string | null;
  reviewNote: string | null;
  splitRuleJson: string | null;
  updatedAt: number;
  id: string;
  date: string | null;
  store: string | null;
  amountCents: number | null;
  category: string | null;
  payerId: string | null;
  cardId: string | null;
  splitType: string | null;
  isDuplicate: number;
}


export interface CloseCycleInput {
  cycleId: string;
  transactionIds: string[];
  confirmed: true;
  revisions: Record<string, number>;
}

export interface ClosingSnapshot {
  transactions: ExpenseSnapshot[];
  members: Member[];
}

export interface Cycle {
  id: string;
  status: 'closed' | 'settled';
  settlementJson: string | null;
  closedByMemberId: string | null;
  closedByName: string | null;
  closingSnapshotJson: string | null;
  closedAt: number;
  settledAt: number | null;
  name: string | null;
}

/** One payer/card group of a closed cycle's expenses, summarized for the cycle list. */
export interface CycleGroup {
  payerId: string;
  cardId: string | null;
  cardNameSnapshot: string | null;
  dateStart: string; // YYYY-MM-DD
  dateEnd: string;
  count: number;
}

export interface Settlement {
  balances: Record<string, number>;
  transfers: Array<{ from: string; to: string; amountCents: number }>;
}

export interface Bootstrap {
  me: { memberId: string; role: 'owner' | 'member' };
  household: {
    id: string; name: string; currencyCode: string; timezone: string;
    customCategories: string[];
    currentCycleName: string | null;
  };
  members: Member[];
  cards: Card[];
  transactions: Transaction[];
  queue: QueueItem[];
  cycles: Cycle[];
  categoryPreferences: Record<string, string>;
}

/** Body shape for POST /api/transactions and the transaction half of queue confirm. */
export interface TxInput {
  id: string;
  date: string;
  store: string;
  amountCents: number;
  category: string;
  payerId: string;
  cardId: string | null;
  splitType: SplitType;
  splitRule: SplitRule | null;
  isStarred?: boolean;
  favoriteName?: string | null;
}

/** Body shape for PATCH /api/transactions/:id. */
export type TxPatch = Partial<Omit<TxInput, 'id'>>;

/** Body shape for POST /api/queue. */
export interface QueueItemInput {
  splitRule?: SplitRule | null;
  sourceFileId?: string | null;
  sourceFileName?: string | null;
  id: string;
  date: string | null;
  store: string | null;
  amountCents: number | null;
  category: string | null;
  payerId: string | null;
  cardId: string | null;
  splitType: string | null;
  isDuplicate?: boolean;
  source: 'manual' | 'csv' | 'image';
}

/** Lifecycle baseline or changed fields with saved revision identity. */
export interface ExpenseSnapshot {
  expenseId: string;
  revision: number;
  state: 'pending' | 'approved' | 'deleted';
  updatedAt: number;
  reviewNote: string | null;
  [field: string]: unknown;
}

export interface ExpenseHistoryEvent {
  id: string;
  expenseId: string;
  eventType: 'legacy_baseline' | 'imported' | 'created' | 'approved' | 'edited' | 'returned_to_pending' | 'deleted' | 'category_suggestion' | 'closed' | 'split';
  actorMemberId: string | null;
  actorName: string | null;
  timestamp: number;
  before: ExpenseSnapshot | null;
  after: ExpenseSnapshot;
  reviewNote: string | null;
}
