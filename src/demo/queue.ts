// Pure module: no React, no DOM API, no `?url` assets. The Workers-runtime parity test loads it.
// Mirrors worker/routes/queue.ts and the queue methods of worker/lib/scope.ts by hand; the parity test guards drift.
import type { ExpenseHistoryEvent, ExpenseSnapshot, QueueItem, Transaction } from '../types';
import { computeShares, type SplitRule, type SplitType } from '../lib/settlement';
import { canNormalizePercentages, customPercentagesError, sameSplitRule } from '../lib/percentages';
import { normalizeMerchantName } from '../lib/category';
import { isDuplicateMatch } from '../lib/duplicates';
import { canonicalCategory } from '../constants';
import {
  validateQueueBulk, validateQueuePatch, validateConfirmBody, validateTxInput,
  isPlainObject, expectedRevision, trimmedString, ID_MAX_LEN, MAX_BULK_BATCH,
  type QueueInputLike, type TxInputLike,
} from '../../worker/lib/validate';
import type { DemoState } from './types';
import { DEMO_REFUSAL, DEMO_SAMPLE_ONLY, HttpError, json } from './http';
import type { Route } from './server';

/** Server rows carry householdId and createdAt; seeded demo rows may not. */
type QueueRow = QueueItem & { householdId?: string; createdAt?: number };
type TxRow = Transaction & { householdId?: string; createdAt?: number; deletedAt?: number | null };

interface QueueContext { state: DemoState; now: () => number; newId: () => string; roster: () => string[] }

// ledger-history.ts:32-34, changedExpenseFields.
const editableFields = ['date', 'store', 'amountCents', 'category', 'payerId', 'cardId',
  'cardNameSnapshot', 'splitType', 'splitRuleJson', 'splitSharesJson', 'isStarred',
  'favoriteName', 'reviewNote', 'isDuplicate'] as const;
const changedExpenseFields = (before: object, after: object) => editableFields.filter((key) =>
  JSON.stringify((before as Record<string, unknown>)[key]) !== JSON.stringify((after as Record<string, unknown>)[key]));

/** ledger-history.ts:27-30. */
function snapshot(row: object, state: ExpenseSnapshot['state']): ExpenseSnapshot {
  const { householdId: _householdId, ...values } = row as Record<string, unknown>;
  return { ...values, state } as ExpenseSnapshot;
}

const conflict = (): never => {
  throw new HttpError(409, 'Expense changed. Reload its saved version before retrying.');
};
const checkRevision = (current: { revision: number }, expected?: number) => {
  if (expected !== undefined && current.revision !== expected) conflict();
};

/** scope.ts assertCustomAllocation: true when an unchanged saved custom rule may be kept as saved. */
function assertCustomAllocation(splitType: string | null, splitRule: SplitRule | null | undefined,
  current?: { splitType: string | null; splitRuleJson: string | null }) {
  if (splitType !== 'custom') return false;
  const unchanged = current?.splitType === splitType
    && sameSplitRule(splitRule ?? null, current.splitRuleJson ? JSON.parse(current.splitRuleJson) : null);
  if (unchanged && canNormalizePercentages(splitRule?.percentages ?? {})) return true;
  const error = customPercentagesError(splitRule?.percentages ?? {});
  if (error) throw new HttpError(400, error);
  return false;
}

export function queueRoutes({ state, now, newId, roster }: QueueContext): Route[] {
  const actor = () => ({ memberId: state.bootstrap.me.memberId,
    displayName: state.bootstrap.members.find((m) => m.id === state.bootstrap.me.memberId)?.displayName ?? null });
  const body = (request: Request) => request.json().catch(() => null) as Promise<unknown>;

  /** scope.ts attribution: a passed previous row keeps its editor. */
  function attribution(revision: number, previous?: { editedByMemberId: string | null; editedByName: string | null }) {
    const { memberId, displayName } = actor();
    return { revision, editedByMemberId: previous ? previous.editedByMemberId : memberId,
      editedByName: previous ? previous.editedByName : displayName, updatedAt: now() };
  }

  /** ledger-history.ts historyValues + publicHistory. */
  function record(eventType: ExpenseHistoryEvent['eventType'], before: ExpenseSnapshot | null, after: ExpenseSnapshot) {
    const { memberId, displayName } = actor();
    state.history.push({ id: newId(), expenseId: after.expenseId, eventType, actorMemberId: memberId,
      actorName: displayName, timestamp: after.updatedAt, before, after, reviewNote: after.reviewNote ?? null });
  }

  /** scope.ts assertOwns: archived members and cards still belong to the household. */
  function assertOwns(refs: { payerId?: string | null; cardId?: string | null }) {
    if (refs.payerId && !state.bootstrap.members.some((m) => m.id === refs.payerId)) throw new HttpError(403, 'Unknown payer');
    if (refs.cardId) {
      const card = state.bootstrap.cards.find((c) => c.id === refs.cardId);
      if (!card) throw new HttpError(403, 'Unknown card');
      if (refs.payerId && card.memberId !== refs.payerId) throw new HttpError(403, 'Card does not belong to the payer');
    }
  }

  function requireQueueItem(id: string): QueueRow {
    const row = state.bootstrap.queue.find((q) => q.id === id);
    if (!row) throw new HttpError(404, 'Queue item not found');
    return row;
  }

  /** scope.ts consumedInputIds: an id that ever started a Pending life cannot be imported again. */
  const consumed = (id: string) => state.history.some((e) => e.before === null && e.after.state === 'pending' && e.after.id === id);

  /** scope.ts queueValues. */
  function queueValues(input: QueueInputLike): QueueRow & { householdId: string; createdAt: number } {
    assertCustomAllocation(input.splitType, input.splitRule);
    return { id: input.id, householdId: state.bootstrap.household.id, expenseId: newId(), ...attribution(1),
      hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null,
      date: input.date, store: input.store, amountCents: input.amountCents,
      category: input.category === null ? null : canonicalCategory(input.category), payerId: input.payerId,
      cardId: input.cardId, splitType: input.splitType, splitRuleJson: input.splitRule ? JSON.stringify(input.splitRule) : null,
      isDuplicate: input.isDuplicate ? 1 : 0, source: input.source,
      sourceFileId: input.sourceFileId ?? null, sourceFileName: input.sourceFileName ?? null,
      reviewNote: null, createdAt: now() };
  }

  /** scope.ts insertQueueItemsBulk; items already passed validateQueueBulk (non-empty, unique ids). */
  function insertQueueItemsBulk(items: QueueInputLike[]) {
    for (const item of items) assertOwns(item); // bulkOwnership
    const existingIds = new Set(items.filter((item) => state.bootstrap.queue.some((q) => q.id === item.id) || consumed(item.id)).map((item) => item.id));
    const toInsert = items.filter((item) => !existingIds.has(item.id));
    const duplicate = toInsert.map((item, i) => Boolean(item.isDuplicate)
      || state.bootstrap.transactions.some((t) => isDuplicateMatch(item, t))
      || state.bootstrap.queue.some((q) => isDuplicateMatch(item, q))
      || toInsert.slice(0, i).some((sib) => isDuplicateMatch(item, sib)));
    const created = toInsert.map((item, i) => ({ ...queueValues(item), isDuplicate: duplicate[i] ? 1 : 0 }));
    state.bootstrap.queue.unshift(...created); // newest createdAt first, as queueItems() orders
    for (const row of created) record('imported', null, snapshot(row, 'pending'));
    return { created, summary: { inserted: created.length, duplicate: created.filter((row) => row.isDuplicate).length,
      rejected: items.length - created.length } };
  }

  /** scope.ts updateQueueItem. */
  function updateQueueItem(id: string, patch: Partial<QueueInputLike>, expected: number) {
    const current = requireQueueItem(id);
    checkRevision(current, expected);
    assertOwns({ payerId: patch.payerId ?? current.payerId, cardId: patch.cardId !== undefined ? patch.cardId : current.cardId });
    const category = patch.category !== undefined
      ? (patch.category === null ? null : canonicalCategory(patch.category))
      : (current.category === null ? null : canonicalCategory(current.category));
    const store = patch.store !== undefined ? patch.store : current.store;
    const values: QueueRow = { ...current, ...attribution(current.revision + 1, current),
      date: patch.date !== undefined ? patch.date : current.date,
      store,
      amountCents: patch.amountCents !== undefined ? patch.amountCents : current.amountCents,
      category,
      payerId: patch.payerId !== undefined ? patch.payerId : current.payerId,
      cardId: patch.cardId !== undefined ? patch.cardId : current.cardId,
      splitType: patch.splitType !== undefined ? patch.splitType : current.splitType,
      splitRuleJson: patch.splitRule !== undefined ? (patch.splitRule ? JSON.stringify(patch.splitRule) : null) : current.splitRuleJson,
      isDuplicate: patch.isDuplicate !== undefined ? (patch.isDuplicate ? 1 : 0) : current.isDuplicate,
    };
    if (patch.splitType !== undefined || patch.splitRule !== undefined) {
      if (assertCustomAllocation(values.splitType, values.splitRuleJson ? JSON.parse(values.splitRuleJson) : null, current)) {
        values.splitRuleJson = current.splitRuleJson;
      }
    }
    if (!changedExpenseFields(current, values).length) return current;
    state.bootstrap.queue[state.bootstrap.queue.indexOf(current)] = values;
    const categoryChanged = patch.category !== undefined
      && category !== (current.category === null ? null : canonicalCategory(current.category));
    if (categoryChanged && category !== null && store && normalizeMerchantName(store)) {
      state.bootstrap.categoryPreferences[normalizeMerchantName(store)] = canonicalCategory(category); // categoryPreferenceUpsert
    }
    return values;
  }

  /** The 'deleted' event of deleteQueueItem / deleteQueueItems, then removal. */
  function deleteRows(rows: QueueRow[]) {
    for (const row of rows) record('deleted', snapshot(row, 'pending'), snapshot({ ...row, ...attribution(row.revision + 1) }, 'deleted'));
    state.bootstrap.queue = state.bootstrap.queue.filter((q) => !rows.includes(q));
  }

  /** scope.ts confirmQueueItem with transactionValues, for a never-approved row. */
  function confirmQueueItem(queueId: string, transactionId: string, input: TxInputLike, expected: number): TxRow {
    const current = requireQueueItem(queueId);
    checkRevision(current, expected);
    // The approval-baseline branch (scope.ts:966-976) is not mirrored; demo Pending rows are never approved.
    if (current.hasBeenApproved) throw new HttpError(403, DEMO_REFUSAL, 'demo_read_only');
    const splitType = input.splitType as SplitType;
    const splitRule: SplitRule | null = (input.splitRule as SplitRule | null)
      ?? (splitType === current.splitType && current.splitRuleJson ? JSON.parse(current.splitRuleJson) : null);
    const unchangedCustom = assertCustomAllocation(splitType, splitRule, current);
    assertOwns({ payerId: input.payerId, cardId: input.cardId });
    const values: TxRow = { id: transactionId, householdId: state.bootstrap.household.id, expenseId: current.expenseId,
      cycleId: null, date: input.date, store: input.store, amountCents: input.amountCents,
      category: canonicalCategory(input.category), payerId: input.payerId, cardId: input.cardId,
      cardNameSnapshot: input.cardId ? state.bootstrap.cards.find((c) => c.id === input.cardId)?.name ?? null : null, splitType,
      splitRuleJson: unchangedCustom ? current.splitRuleJson : (splitRule ? JSON.stringify(splitRule) : null),
      splitSharesJson: JSON.stringify(computeShares(input.amountCents, splitType, splitRule, roster())),
      isStarred: input.isStarred ? 1 : 0, favoriteName: input.favoriteName ?? null, deletedAt: null,
      ...attribution(current.revision + 1, current), source: current.source,
      hasBeenApproved: true, lastEditedAt: current.lastEditedAt, parentExpenseId: current.parentExpenseId,
      sourceFileId: current.sourceFileId, sourceFileName: current.sourceFileName,
      reviewNote: current.reviewNote, createdAt: current.createdAt };
    record('approved', snapshot(current, 'pending'), snapshot(values, 'approved'));
    state.bootstrap.queue = state.bootstrap.queue.filter((q) => q !== current);
    const at = state.bootstrap.transactions.findIndex((t) => t.date < values.date); // activeTransactions(): date desc
    state.bootstrap.transactions.splice(at < 0 ? state.bootstrap.transactions.length : at, 0, values);
    return values;
  }

  return [
    {
      method: 'POST', pattern: '/api/queue/bulk', handler: async ({ request }) => {
        const raw = await body(request);
        if (isPlainObject(raw) && Array.isArray(raw.items) && raw.items.some((i) => isPlainObject(i) && i.source === 'csv')) {
          return json({ error: DEMO_SAMPLE_ONLY, reason: 'demo_sample_only' }, 403);
        }
        const { items, fields } = validateQueueBulk(raw, roster());
        if (!items) return json({ error: 'Invalid queue import', fields }, 400);
        return json(insertQueueItemsBulk(items), 201);
      },
    },
    {
      // worker/routes/queue.ts delete-bulk checks, then deleteQueueItems with revisions always present.
      method: 'POST', pattern: '/api/queue/delete-bulk', handler: async ({ request }) => {
        const raw = await body(request);
        if (!isPlainObject(raw) || !Array.isArray(raw.ids) || raw.ids.length === 0) {
          return json({ error: 'Invalid queue deletion', fields: { ids: 'Expected a non-empty array' } }, 400);
        }
        if (raw.ids.length > MAX_BULK_BATCH) {
          return json({ error: 'Invalid queue deletion', fields: { ids: `At most ${MAX_BULK_BATCH} items` } }, 400);
        }
        const ids = raw.ids.map((id) => trimmedString(id, ID_MAX_LEN));
        if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) {
          return json({ error: 'Invalid queue deletion', fields: { ids: 'Expected unique non-empty ids' } }, 400);
        }
        const revisions = raw.revisions;
        if (!isPlainObject(revisions) || ids.some((id) => !expectedRevision(revisions[id!]))) {
          return json({ error: 'Expected revisions for every selected expense' }, 400);
        }
        const rows = state.bootstrap.queue.filter((q) => ids.includes(q.id));
        rows.forEach((row) => checkRevision(row, revisions[row.id] as number));
        if (rows.length !== ids.length) conflict();
        deleteRows(rows);
        return json({ deletedIds: ids });
      },
    },
    {
      method: 'PATCH', pattern: '/api/queue/:id', handler: async ({ request, params }) => {
        const raw = await body(request);
        if (!isPlainObject(raw) || !expectedRevision(raw.revision)) return json({ error: 'Expected expense revision' }, 400);
        const { value, fields } = validateQueuePatch(raw, roster());
        if (!value) return json({ error: 'Invalid queue item', fields }, 400);
        return json(updateQueueItem(params.id, value as Partial<QueueInputLike>, raw.revision));
      },
    },
    {
      method: 'DELETE', pattern: '/api/queue/:id', handler: async ({ request, params }) => {
        const raw = await body(request);
        if (!isPlainObject(raw) || !expectedRevision(raw.revision)) return json({ error: 'Expected expense revision' }, 400);
        const current = requireQueueItem(params.id);
        checkRevision(current, raw.revision);
        deleteRows([current]);
        return new Response(null, { status: 204 });
      },
    },
    {
      method: 'POST', pattern: '/api/queue/:id/confirm', handler: async ({ request, params }) => {
        const raw = await body(request);
        if (!isPlainObject(raw) || !expectedRevision(raw.revision)) return json({ error: 'Expected expense revision' }, 400);
        const { value, fields } = validateConfirmBody(raw);
        if (!value) return json({ error: 'Invalid queue confirmation', fields }, 400);
        const tx = validateTxInput(value.transaction, roster());
        if (!tx.value) return json({ error: 'Invalid transaction', fields: tx.fields }, 400);
        return json(confirmQueueItem(params.id, value.transactionId, tx.value, raw.revision), 201);
      },
    },
  ];
}
