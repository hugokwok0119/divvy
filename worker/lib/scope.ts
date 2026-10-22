/**
 * THE household boundary. D1 has no row-level security, so tenant isolation
 * lives here and nowhere else.
 *
 * RULE: no route handler may import `drizzle` or touch `env.DB`. Every read and
 * write goes through the ScopedRepository returned by requireScope(), which
 * always filters on householdId.
 */
import { getTableColumns, eq, and, inArray, isNull, isNotNull, asc, desc, sql, type SQL } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import {
  households, householdMembers, memberAccounts, cards, cycles, transactions,
  queueItems as queueTable, categoryPreferences, expenseHistory, reminderCompletions,
} from '../db/schema';
import { conditionalInsert, conditionalJsonInsert, eventExists, historyValues, historyStatement, snapshot, publicHistory, changedExpenseFields, type ExpenseActor } from './ledger-history';

type ApprovalBaseline = Pick<typeof transactions.$inferSelect,
  'amountCents' | 'cardId' | 'cardNameSnapshot' | 'splitType' | 'splitRuleJson' | 'splitSharesJson' | 'isStarred' | 'favoriteName'>;
import { createAuth } from '../auth';
import type { AllowlistEntry } from './onboarding';
import type { Env } from '../index';
import { computeShares, computeSettlement, type SplitType, type SplitRule, type Settlement } from '../../src/lib/settlement';
import { canNormalizePercentages, customPercentagesError, sameSplitRule } from '../../src/lib/percentages';
import { normalizeMerchantName } from '../../src/lib/category';
import { isDuplicateMatch } from '../../src/lib/duplicates';
import { canonicalCategory } from '../../src/constants';
import { closedCycleCard } from '../../src/lib/money';
import { checkAndIncrement, DAILY_AI_LIMIT } from './ratelimit';

export interface OwnershipRefs {
  payerId?: string | null;
  cardId?: string | null;
  cycleId?: string | null;
}

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

export interface PublicMember {
  id: string;
  displayName: string;
  role: string;
  sortOrder: number;
  archivedAt: number | null;
}

export interface QueueInput {
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
  splitRule?: SplitRule | null;
  isDuplicate?: boolean;
  source: 'manual' | 'csv' | 'image';
}

export class ScopedRepository {
  constructor(
    private readonly db: DrizzleD1Database,
    public readonly householdId: string,
    private readonly actor?: ExpenseActor,
  ) {}

  async household() {
    const rows = await this.db
      .select().from(households)
      .where(eq(households.id, this.householdId)).limit(1);
    if (rows.length === 0) throw new HTTPException(404, { message: 'Household not found' });
    return rows[0];
  }

  async members() {
    return this.db
      .select().from(householdMembers)
      .where(eq(householdMembers.householdId, this.householdId))
      .orderBy(asc(householdMembers.sortOrder));
  }

  /**
   * The single definition of what a member looks like outside the worker.
   * userId is the Better Auth account id and never leaves the server — every
   * route that hands members to a client (bootstrap, GET /api/members,
   * exportAll) must go through this, not its own hand-picked shape.
   */
  async publicMembers(): Promise<PublicMember[]> {
    const rows = await this.members();
    return rows.map(({ id, displayName, role, sortOrder, archivedAt }) => ({
      id, displayName, role, sortOrder, archivedAt,
    }));
  }

  /** Active participant ids, in stable order. Archived members are excluded. */
  async roster(): Promise<string[]> {
    const rows = await this.db
      .select({ id: householdMembers.id }).from(householdMembers)
      .where(and(
        eq(householdMembers.householdId, this.householdId),
        isNull(householdMembers.archivedAt),
      ))
      .orderBy(asc(householdMembers.sortOrder));
    return rows.map((r) => r.id);
  }

  async cards() {
    return this.db
      .select().from(cards)
      .where(eq(cards.householdId, this.householdId))
      .orderBy(asc(cards.sortOrder));
  }

  async cycles() {
    return this.db.select().from(cycles)
      .where(eq(cycles.householdId, this.householdId))
      .orderBy(desc(cycles.closedAt));
  }

  /** Payer/card groups of every closed cycle's live expenses, for list labels without cycle detail. */
  async cycleGroups() {
    const count = sql<number>`count(*)`;
    const dateStart = sql<string>`min(${transactions.date})`;
    return this.db.select({
      cycleId: transactions.cycleId, payerId: transactions.payerId, cardId: transactions.cardId,
      cardNameSnapshot: transactions.cardNameSnapshot, dateStart, dateEnd: sql<string>`max(${transactions.date})`, count,
    }).from(transactions).where(and(
      eq(transactions.householdId, this.householdId),
      isNotNull(transactions.cycleId),
      isNull(transactions.deletedAt),
    ))
      .groupBy(transactions.cycleId, transactions.payerId, transactions.cardId, transactions.cardNameSnapshot)
      .orderBy(desc(count), asc(dateStart), asc(transactions.payerId), asc(transactions.cardId));
  }

  async requireCycle(cycleId: string) {
    const rows = await this.db.select().from(cycles)
      .where(and(eq(cycles.id, cycleId), eq(cycles.householdId, this.householdId))).limit(1);
    if (rows.length === 0) throw new HTTPException(404, { message: 'Cycle not found' });
    return rows[0];
  }

  /**
   * Writes verify ownership too, not just reads. A crafted request must not be
   * able to reference another household's rows.
   */
  async assertOwns(refs: OwnershipRefs): Promise<void> {
    if (refs.payerId) {
      const rows = await this.db
        .select({ id: householdMembers.id }).from(householdMembers)
        .where(and(
          eq(householdMembers.id, refs.payerId),
          eq(householdMembers.householdId, this.householdId),
        )).limit(1);
      if (rows.length === 0) throw new HTTPException(403, { message: 'Unknown payer' });
    }

    if (refs.cardId) {
      const rows = await this.db
        .select({ memberId: cards.memberId }).from(cards)
        .where(and(eq(cards.id, refs.cardId), eq(cards.householdId, this.householdId)))
        .limit(1);
      if (rows.length === 0) throw new HTTPException(403, { message: 'Unknown card' });
      if (refs.payerId && rows[0].memberId !== refs.payerId) {
        throw new HTTPException(403, { message: 'Card does not belong to the payer' });
      }
    }

    if (refs.cycleId) {
      const rows = await this.db
        .select({ id: cycles.id }).from(cycles)
        .where(and(eq(cycles.id, refs.cycleId), eq(cycles.householdId, this.householdId)))
        .limit(1);
      if (rows.length === 0) throw new HTTPException(403, { message: 'Unknown cycle' });
    }
  }

  async activeTransactions() {
    return this.db.select().from(transactions).where(and(
      eq(transactions.householdId, this.householdId),
      isNull(transactions.cycleId),
      isNull(transactions.deletedAt),
    )).orderBy(desc(transactions.date));
  }

  async archivedTransactions() {
    return this.db.select().from(transactions).where(and(
      eq(transactions.householdId, this.householdId),
      isNotNull(transactions.cycleId),
      isNull(transactions.deletedAt),
    )).orderBy(desc(transactions.date));
  }

  async transactionsByCycle(cycleId: string) {
    return this.db.select().from(transactions).where(and(
      eq(transactions.householdId, this.householdId),
      eq(transactions.cycleId, cycleId),
      isNull(transactions.deletedAt),
    )).orderBy(desc(transactions.date));
  }

  private async requireTransaction(id: string) {
    const rows = await this.db.select().from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.householdId, this.householdId)))
      .limit(1);
    if (rows.length === 0) throw new HTTPException(404, { message: 'Transaction not found' });
    return rows[0];
  }

  private async cardName(cardId: string | null): Promise<string | null> {
    if (!cardId) return null;
    const rows = await this.db.select({ name: cards.name }).from(cards)
      .where(and(eq(cards.id, cardId), eq(cards.householdId, this.householdId))).limit(1);
    return rows[0]?.name ?? null;
  }

  private attribution(revision: number, previous?: { editedByMemberId: string | null; editedByName: string | null }) {
    return { revision, editedByMemberId: previous ? previous.editedByMemberId : this.actor?.memberId ?? null,
      editedByName: previous ? previous.editedByName : this.actor?.displayName ?? null, updatedAt: Date.now() };
  }

  private checkRevision(current: { revision: number }, expected?: number) {
    if (expected !== undefined && current.revision !== expected) this.conflict();
  }

  private conflict(): never {
    throw new HTTPException(409, { message: 'Expense changed. Reload its saved version before retrying.' });
  }

  private validatePortion(total: number | null, amountCents: number) {
    if (total === null || !Number.isSafeInteger(amountCents) || amountCents === 0
      || Math.sign(amountCents) !== Math.sign(total) || Math.abs(amountCents) >= Math.abs(total)) {
      throw new HTTPException(400, { message: 'Enter an amount greater than zero and less than the total, with the same sign.' });
    }
  }

  private frozenParticipants(row: { splitType: string; splitSharesJson: string; splitRuleJson: string | null }) {
    const rule: SplitRule | null = row.splitRuleJson ? JSON.parse(row.splitRuleJson) : null;
    // Zero-weight custom members are omitted from shares but remain part of the saved rule.
    const ruleIds = row.splitType === 'custom' ? Object.keys(rule?.percentages ?? {})
      : row.splitType === 'single' && rule?.memberId ? [rule.memberId] : [];
    return [...new Set([...Object.keys(JSON.parse(row.splitSharesJson)), ...ruleIds])].sort();
  }

  private transactionGuard(current: typeof transactions.$inferSelect) {
    const conditions = and(eq(transactions.id, current.id), eq(transactions.householdId, this.householdId),
      eq(transactions.revision, current.revision), isNull(transactions.deletedAt),
      current.cycleId === null ? isNull(transactions.cycleId) : eq(transactions.cycleId, current.cycleId),
      sql`(${transactions.cycleId} is null or exists (select 1 from ${cycles} where ${cycles.id} = ${transactions.cycleId} and ${cycles.householdId} = ${this.householdId} and ${cycles.status} <> 'settled'))`)!;
    return sql`exists (select 1 from ${transactions} where ${conditions})`;
  }

  private queueGuard(current: typeof queueTable.$inferSelect) {
    const conditions = and(eq(queueTable.id, current.id), eq(queueTable.householdId, this.householdId), eq(queueTable.revision, current.revision))!;
    return sql`exists (select 1 from ${queueTable} where ${conditions})`;
  }

  private async consumedInputIds(ids: string[], state: 'pending' | 'approved') {
    const originalId = sql<string>`json_extract(${expenseHistory.afterJson}, '$.id')`;
    const rows = await this.db.select({ id: originalId }).from(expenseHistory).where(and(
      eq(expenseHistory.householdId, this.householdId), isNull(expenseHistory.beforeJson),
      sql`json_extract(${expenseHistory.afterJson}, '$.state') = ${state}`, sql`${originalId} in (select value from json_each(${JSON.stringify(ids)}))`,
    ));
    return new Set(rows.map((row) => row.id));
  }

  private inputUnused(id: string, state: 'pending' | 'approved') {
    return sql`not exists (select 1 from ${expenseHistory} where ${expenseHistory.householdId} = ${this.householdId} and ${expenseHistory.beforeJson} is null and json_extract(${expenseHistory.afterJson}, '$.state') = ${state} and json_extract(${expenseHistory.afterJson}, '$.id') = ${id})`;
  }

  private async bulkOwnership(items: OwnershipRefs[]) {
    const [members, ownedCards] = await Promise.all([this.members(), this.cards()]);
    for (const item of items) {
      if (item.payerId && !members.some(member => member.id === item.payerId)) {
        throw new HTTPException(403, { message: 'Unknown payer' });
      }
      if (item.cardId) {
        const card = ownedCards.find(card => card.id === item.cardId);
        if (!card) throw new HTTPException(403, { message: 'Unknown card' });
        if (item.payerId && card.memberId !== item.payerId) {
          throw new HTTPException(403, { message: 'Card does not belong to the payer' });
        }
      }
    }
    return { roster: members.filter(member => member.archivedAt === null).map(member => member.id),
      cardNames: new Map(ownedCards.map(card => [card.id, card.name])) };
  }

  private assertCustomAllocation(splitType: string | null, splitRule: SplitRule | null | undefined,
    current?: { splitType: string | null; splitRuleJson: string | null }) {
    if (splitType !== 'custom') return false;
    const unchanged = current?.splitType === splitType
      && sameSplitRule(splitRule ?? null, current.splitRuleJson ? JSON.parse(current.splitRuleJson) : null);
    if (unchanged && canNormalizePercentages(splitRule?.percentages ?? {})) return true;
    const error = customPercentagesError(splitRule?.percentages ?? {});
    if (error) throw new HTTPException(400, { message: error });
    return false;
  }

  private async transactionValues(input: TxInput, owned?: { roster: string[]; cardNames: Map<string, string> },
    current?: { splitType: string | null; splitRuleJson: string | null }) {
    const unchangedCustom = this.assertCustomAllocation(input.splitType, input.splitRule, current);
    if (!owned) await this.assertOwns({ payerId: input.payerId, cardId: input.cardId });
    const now = Date.now();
    return { id: input.id, householdId: this.householdId, expenseId: crypto.randomUUID(),
      hasBeenApproved: true, lastEditedAt: null, parentExpenseId: null,
      ...this.attribution(1), cycleId: null, date: input.date, store: input.store,
      amountCents: input.amountCents, category: canonicalCategory(input.category), payerId: input.payerId,
      cardId: input.cardId, cardNameSnapshot: owned ? (input.cardId ? owned.cardNames.get(input.cardId)! : null) : await this.cardName(input.cardId), splitType: input.splitType,
      splitRuleJson: unchangedCustom ? current!.splitRuleJson : (input.splitRule ? JSON.stringify(input.splitRule) : null),
      splitSharesJson: JSON.stringify(computeShares(input.amountCents, input.splitType, input.splitRule, owned?.roster ?? await this.roster())),
      isStarred: input.isStarred ? 1 : 0, favoriteName: input.favoriteName ?? null,
      source: 'manual', sourceFileId: null, sourceFileName: null, reviewNote: null,
      createdAt: now, deletedAt: null };
  }

  /** Idempotent create; row and initial saved history share the D1 transaction. */
  async insertTransaction(input: TxInput) {
    const existing = await this.db.select().from(transactions).where(and(eq(transactions.id, input.id), eq(transactions.householdId, this.householdId))).limit(1);
    if (existing.length) return existing[0];
    if ((await this.consumedInputIds([input.id], 'approved')).has(input.id)) this.conflict();
    const values = await this.transactionValues(input);
    const event = historyStatement(this.db, this.householdId, this.actor, 'created', null, snapshot(values, 'approved'), sql`changes() = 1`);
    await this.db.batch([conditionalInsert(this.db, transactions, values, this.inputUnused(input.id, 'approved')).onConflictDoNothing(), event.statement]);
    return this.requireTransaction(input.id);
  }

  async insertTransactionsBulk(items: TxInput[]): Promise<Array<typeof transactions.$inferSelect>> {
    if (!items.length) throw new HTTPException(400, { message: 'transactions must not be empty' });
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) throw new HTTPException(400, { message: 'Duplicate transaction id within the same import' });
    const owned = await this.bulkOwnership(items);
    const selectedIds = sql`${transactions.id} in (select value from json_each(${JSON.stringify(ids)}))`;
    const existing = await this.db.select().from(transactions).where(and(eq(transactions.householdId, this.householdId), selectedIds));
    const consumed = await this.consumedInputIds(ids, 'approved');
    if (items.some((item) => consumed.has(item.id) && !existing.some((row) => row.id === item.id))) this.conflict();
    const toInsert = items.filter((item) => !existing.some((row) => row.id === item.id));
    const values = await Promise.all(toInsert.map((item) => this.transactionValues(item, owned)));
    const versions = JSON.stringify(existing.map(({ id, expenseId, revision, cycleId }) => ({ id, expenseId, revision, cycleId })));
    const guard = and(sql`(select count(*) from json_each(${versions}) selected join ${transactions}
      on ${transactions.id} = json_extract(selected.value, '$.id')
      and ${transactions.expenseId} = json_extract(selected.value, '$.expenseId')
      and ${transactions.revision} = json_extract(selected.value, '$.revision')
      and ${transactions.cycleId} is json_extract(selected.value, '$.cycleId')
      where ${transactions.householdId} = ${this.householdId}) = ${existing.length}`,
      sql`not exists (select 1 from ${expenseHistory} where ${expenseHistory.householdId} = ${this.householdId}
        and ${expenseHistory.beforeJson} is null and json_extract(${expenseHistory.afterJson}, '$.state') = 'approved'
        and json_extract(${expenseHistory.afterJson}, '$.id') in (select value from json_each(${JSON.stringify(toInsert.map(item => item.id))})))`)!;
    const events = values.map(value => historyValues(this.householdId, this.actor, 'imported', null, snapshot(value, 'approved')));
    const gate = events.length ? eventExists(events[0].id) : guard;
    // Validate the entire selection once before its history and expense rows are inserted atomically.
    const statements = events.length ? [conditionalJsonInsert(this.db, expenseHistory, events, guard),
      conditionalJsonInsert(this.db, transactions, values, gate)] : [];
    const results = await this.db.batch([...statements, this.db.select().from(transactions).where(and(
      eq(transactions.householdId, this.householdId), selectedIds, gate,
    ))] as never) as unknown as Array<D1Result | Array<typeof transactions.$inferSelect>>;
    const saved = results[results.length - 1] as Array<typeof transactions.$inferSelect>;
    if (saved.length !== ids.length) this.conflict();
    const byId = new Map(saved.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)!);
  }

  async updateTransaction(id: string, patch: Partial<TxInput>, expectedRevision?: number) {
    const current = await this.requireTransaction(id);
    this.checkRevision(current, expectedRevision);
    await this.assertCycleEditable(current.cycleId);
    await this.assertOwns({
      payerId: patch.payerId ?? current.payerId,
      cardId: patch.cardId !== undefined ? patch.cardId : current.cardId,
    });

    const amountCents = patch.amountCents ?? current.amountCents;
    const splitType = (patch.splitType ?? current.splitType) as SplitType;
    const splitRule = patch.splitRule !== undefined
      ? patch.splitRule
      : (current.splitRuleJson ? JSON.parse(current.splitRuleJson) : null);

    const unchangedCustom = this.assertCustomAllocation(splitType, splitRule, current);
    // An explicit change of splitType or splitRule means the caller is
    // deliberately re-splitting and may name someone who joined later. An
    // amount-only edit must not disturb who was in on the expense, so it stays
    // frozen to the transaction's original participants. See task-11 fix round 2.
    const explicitReSplit = !unchangedCustom && (patch.splitType !== undefined || patch.splitRule !== undefined);
    const splitChanged = amountCents !== current.amountCents || explicitReSplit;
    const currentShares: Record<string, number> = JSON.parse(current.splitSharesJson);
    const frozen = this.frozenParticipants(current);
    const participants = explicitReSplit
      ? [...new Set([...frozen, ...(await this.roster())])].sort()
      : frozen;
    const shares = splitChanged
      ? computeShares(amountCents, splitType, splitRule, participants)
      : currentShares;
    const cardId = patch.cardId !== undefined ? patch.cardId : current.cardId;
    const category = patch.category !== undefined
      ? canonicalCategory(patch.category)
      : canonicalCategory(current.category);
    const store = patch.store ?? current.store;

    const attribution = this.attribution(current.revision + 1);
    const values = { ...current, ...attribution, lastEditedAt: attribution.updatedAt,
      date: patch.date ?? current.date,
      store,
      amountCents,
      category,
      payerId: patch.payerId ?? current.payerId,
      cardId,
      cardNameSnapshot: cardId === current.cardId
        ? current.cardNameSnapshot
        : await this.cardName(cardId),
      splitType,
      splitRuleJson: patch.splitRule !== undefined && !unchangedCustom ? (splitRule ? JSON.stringify(splitRule) : null) : current.splitRuleJson,
      splitSharesJson: splitChanged ? JSON.stringify(shares) : current.splitSharesJson,
      isStarred: patch.isStarred !== undefined ? (patch.isStarred ? 1 : 0) : current.isStarred,
      favoriteName: patch.favoriteName !== undefined ? patch.favoriteName : current.favoriteName,
    };
    if (!changedExpenseFields(current, values).length) return current;
    const event = historyStatement(this.db, this.householdId, this.actor, 'edited', snapshot(current, 'approved'), snapshot(values, 'approved'), this.transactionGuard(current));
    const update = this.db.update(transactions).set(values).where(and(eq(transactions.id, id), eq(transactions.householdId, this.householdId), eventExists(event.id)));

    const statements = [event.statement, update];
    if (patch.category !== undefined
      && category !== canonicalCategory(current.category)
      && normalizeMerchantName(store)) {
      statements.push(this.categoryPreferenceUpsert(store, category, eventExists(event.id)) as never);
    }
    const results = await this.db.batch(statements as never) as D1Result[];
    if (results[0].meta.changes !== 1) this.conflict();

    return this.requireTransaction(id);
  }

  /** Split the amount and both history records in one guarded D1 batch. */
  async splitTransaction(id: string, transactionId: string, amountCents: number, expectedRevision: number) {
    const current = await this.requireTransaction(id);
    await this.assertCycleEditable(current.cycleId);
    const [previous] = await this.db.select().from(expenseHistory).where(and(
      eq(expenseHistory.householdId, this.householdId), eq(expenseHistory.sourceRowId, id),
      eq(expenseHistory.targetRowId, transactionId), eq(expenseHistory.eventType, 'edited'),
    )).limit(1);
    if (previous) {
      const before = JSON.parse(previous.beforeJson!);
      const after = JSON.parse(previous.afterJson);
      const separated = await this.requireTransaction(transactionId);
      if (before.revision !== expectedRevision || before.amountCents - after.amountCents !== amountCents
        || current.revision !== after.revision || separated.revision !== 1 || separated.cycleId !== current.cycleId) this.conflict();
      return { original: current, separated };
    }
    this.checkRevision(current, expectedRevision);
    this.validatePortion(current.amountCents, amountCents);
    const participants = this.frozenParticipants(current);
    const splitRule = current.splitRuleJson ? JSON.parse(current.splitRuleJson) : null;
    const attribution = this.attribution(current.revision + 1);
    const original = { ...current, ...attribution, lastEditedAt: attribution.updatedAt,
      amountCents: current.amountCents - amountCents,
      splitSharesJson: JSON.stringify(computeShares(current.amountCents - amountCents, current.splitType as SplitType, splitRule, participants)) };
    const separated = { ...current, id: transactionId, expenseId: crypto.randomUUID(), ...this.attribution(1),
      parentExpenseId: current.expenseId, lastEditedAt: attribution.updatedAt,
      amountCents, splitSharesJson: JSON.stringify(computeShares(amountCents, current.splitType as SplitType, splitRule, participants)),
      isStarred: 0, favoriteName: null, createdAt: Date.now() };
    const guard = and(this.transactionGuard(current), this.inputUnused(transactionId, 'approved'),
      sql`not exists (select 1 from ${transactions} where ${transactions.id} = ${transactionId})`)!;
    const event = historyStatement(this.db, this.householdId, this.actor, 'edited', snapshot(current, 'approved'),
      snapshot(original, 'approved'), guard, id, transactionId);
    const gate = eventExists(event.id);
    const [result] = await this.db.batch([
      event.statement,
      this.db.update(transactions).set(original).where(and(eq(transactions.id, id), eq(transactions.householdId, this.householdId), gate)),
      conditionalInsert(this.db, transactions, separated, gate),
      historyStatement(this.db, this.householdId, this.actor, 'created', null, snapshot(separated, 'approved'), gate, id, transactionId).statement,
    ]);
    if (result.meta.changes !== 1) this.conflict();
    return { original: await this.requireTransaction(id), separated: await this.requireTransaction(transactionId) };
  }

  async softDeleteTransaction(id: string, expectedRevision?: number): Promise<void> {
    const current = await this.requireTransaction(id);
    this.checkRevision(current, expectedRevision);
    await this.assertCycleEditable(current.cycleId);
    const values = { ...current, ...this.attribution(current.revision + 1), deletedAt: Date.now() };
    const event = historyStatement(this.db, this.householdId, this.actor, 'deleted', snapshot(current, 'approved'), snapshot(values, 'deleted'), this.transactionGuard(current));
    const [saved] = await this.db.batch([event.statement, this.db.update(transactions).set(values).where(and(eq(transactions.id, id), eq(transactions.householdId, this.householdId), eventExists(event.id)))]);
    if (saved.meta.changes !== 1) this.conflict();
  }

  /** Validate every selected version once inside the batch, then gate every write on its first event. */
  async closeCycle(cycleId: string, transactionIds: string[], revisions: Record<string, number>) {
    if (transactionIds.length === 0 || new Set(transactionIds).size !== transactionIds.length) {
      throw new HTTPException(400, { message: 'Select at least one transaction, with no duplicate ids' });
    }
    const selectedIds = sql`${transactions.id} in (select value from json_each(${JSON.stringify(transactionIds)}))`;
    const rows = await this.db.select().from(transactions).where(and(
      eq(transactions.householdId, this.householdId), selectedIds,
      isNull(transactions.cycleId), isNull(transactions.deletedAt),
    ));
    if (rows.length !== transactionIds.length) this.conflict();
    for (const row of rows) {
      if (!Number.isSafeInteger(revisions[row.id]) || revisions[row.id] < 1) {
        throw new HTTPException(400, { message: 'Every selected transaction requires a current revision' });
      }
      this.checkRevision(row, revisions[row.id]);
    }
    const ordered = transactionIds.map(id => rows.find(row => row.id === id)!);
    const now = Date.now();
    const versions = JSON.stringify(ordered.map(({ id, expenseId, revision }) => ({ id, expenseId, revision })));
    const guard = and(sql`(select count(*) from json_each(${versions}) selected join ${transactions}
      on ${transactions.id} = json_extract(selected.value, '$.id')
      and ${transactions.expenseId} = json_extract(selected.value, '$.expenseId')
      and ${transactions.revision} = json_extract(selected.value, '$.revision')
      where ${transactions.householdId} = ${this.householdId}
      and ${transactions.cycleId} is null and ${transactions.deletedAt} is null) = ${ordered.length}`,
      sql`not exists (select 1 from ${cycles} where ${cycles.id} = ${cycleId})`)!;
    const after = ordered.map(row => ({ ...row, cycleId, revision: row.revision + 1, updatedAt: now }));
    const events = ordered.map((row, index) => ({
      id: crypto.randomUUID(), householdId: this.householdId, expenseId: row.expenseId,
      revision: after[index].revision, eventType: 'closed', actorMemberId: this.actor?.memberId ?? null,
      actorName: this.actor?.displayName ?? null, timestamp: now,
      beforeJson: JSON.stringify(snapshot(row, 'approved')), afterJson: JSON.stringify(snapshot(after[index], 'approved')),
      reviewNote: row.reviewNote, sourceRowId: null, targetRowId: null,
    }));
    const gate = eventExists(events[0].id);
    // JSON keeps parameter and query counts constant for any selected expense count.
    const history = this.db.insert(expenseHistory).select(sql`select ${sql.join(
      Object.keys(getTableColumns(expenseHistory)).map(key => sql`json_extract(closing.value, ${`$.${key}`})`), sql`, `,
    )} from json_each(${JSON.stringify(events)}) closing where ${guard}`);
    const cycle = { id: cycleId, householdId: this.householdId, status: 'closed',
      closedAt: now, settledAt: null, settlementJson: null,
      closedByMemberId: this.actor?.memberId ?? null, closedByName: this.actor?.displayName ?? null,
      closingSnapshotJson: JSON.stringify({ transactions: after.map(row => snapshot(row, 'approved')),
        members: await this.publicMembers() }),
      name: sql`(select ${households.currentCycleName} from ${households} where ${households.id} = ${this.householdId})`,
    };
    const [saved] = await this.db.batch([
      history,
      conditionalInsert(this.db, cycles, cycle, gate),
      this.db.update(transactions).set({ cycleId, revision: sql`${transactions.revision} + 1`, updatedAt: now }).where(and(
        eq(transactions.householdId, this.householdId), selectedIds, gate,
      )),
      this.db.update(households).set({ currentCycleName: null }).where(and(eq(households.id, this.householdId), gate)),
    ]);
    if (saved.meta.changes !== ordered.length) this.conflict();
    return this.requireCycle(cycleId);
  }

  /** A null name returns the open cycle to its default label. */
  async renameCurrentCycle(name: string | null) {
    await this.db.update(households).set({ currentCycleName: name }).where(eq(households.id, this.householdId));
    return { name };
  }

  async renameCycle(cycleId: string, name: string | null) {
    const result = await this.db.update(cycles).set({ name })
      .where(and(eq(cycles.id, cycleId), eq(cycles.householdId, this.householdId)));
    if (result.meta.changes !== 1) throw new HTTPException(404, { message: 'Cycle not found' });
    return this.requireCycle(cycleId);
  }

  /** Live while the cycle is closed. The frozen snapshot once it is settled. */
  async cycleSettlement(cycleId: string): Promise<Settlement> {
    const cycle = await this.requireCycle(cycleId);
    if (cycle.status === 'settled') {
      if (!cycle.settlementJson) {
        throw new HTTPException(500, {
          message: `Cycle ${cycleId} is settled but has no settlement snapshot`,
        });
      }
      return JSON.parse(cycle.settlementJson) as Settlement;
    }
    const rows = await this.transactionsByCycle(cycleId);
    return computeSettlement(
      rows.map((r) => ({
        payerId: r.payerId,
        amountCents: r.amountCents,
        shares: JSON.parse(r.splitSharesJson),
      })),
      await this.roster(),
    );
  }

  async settleCycle(cycleId: string) {
    const cycle = await this.requireCycle(cycleId);
    if (cycle.status === 'settled') {
      throw new HTTPException(409, { message: 'Cycle is already settled' });
    }
    const settlement = await this.cycleSettlement(cycleId);
    await this.db.update(cycles).set({
      status: 'settled',
      settlementJson: JSON.stringify(settlement),
      settledAt: Date.now(),
    }).where(and(eq(cycles.id, cycleId), eq(cycles.householdId, this.householdId)));
    return this.requireCycle(cycleId);
  }

  async unsettleCycle(cycleId: string) {
    const cycle = await this.requireCycle(cycleId);
    if (cycle.status !== 'settled') {
      throw new HTTPException(409, { message: 'Cycle is not settled' });
    }
    const result = await this.db.update(cycles).set({
      status: 'closed',
      settlementJson: null,
      settledAt: null,
    }).where(and(
      eq(cycles.id, cycleId),
      eq(cycles.householdId, this.householdId),
      eq(cycles.status, 'settled'),
    ));
    if (result.meta.changes !== 1) {
      throw new HTTPException(409, { message: 'Cycle is no longer settled' });
    }
    return this.requireCycle(cycleId);
  }

  /** Active and closed cycles are editable. Settled ones are frozen. */
  async assertCycleEditable(cycleId: string | null): Promise<void> {
    if (!cycleId) return;
    const cycle = await this.requireCycle(cycleId);
    if (cycle.status === 'settled') {
      throw new HTTPException(409, {
        message: 'This cycle is settled. Add an adjustment to the current cycle instead.',
      });
    }
  }

  async queueItems() {
    return this.db.select().from(queueTable)
      .where(eq(queueTable.householdId, this.householdId))
      .orderBy(desc(queueTable.createdAt));
  }

  private async requireQueueItem(id: string) {
    const rows = await this.db.select().from(queueTable)
      .where(and(eq(queueTable.id, id), eq(queueTable.householdId, this.householdId))).limit(1);
    if (rows.length === 0) throw new HTTPException(404, { message: 'Queue item not found' });
    return rows[0];
  }

  private queueValues(input: QueueInput) {
    this.assertCustomAllocation(input.splitType, input.splitRule);
    const now = Date.now();
    return { id: input.id, householdId: this.householdId, expenseId: crypto.randomUUID(), ...this.attribution(1),
      hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null,
      date: input.date, store: input.store, amountCents: input.amountCents,
      category: input.category === null ? null : canonicalCategory(input.category), payerId: input.payerId,
      cardId: input.cardId, splitType: input.splitType, splitRuleJson: input.splitRule ? JSON.stringify(input.splitRule) : null,
      isDuplicate: input.isDuplicate ? 1 : 0, source: input.source,
      sourceFileId: input.sourceFileId ?? null, sourceFileName: input.sourceFileName ?? null,
      reviewNote: null, createdAt: now };
  }

  async insertQueueItem(input: QueueInput) {
    const existing = await this.db.select().from(queueTable).where(and(eq(queueTable.id, input.id), eq(queueTable.householdId, this.householdId))).limit(1);
    if (existing.length) return existing[0];
    await this.assertOwns({ payerId: input.payerId, cardId: input.cardId });
    if ((await this.consumedInputIds([input.id], 'pending')).has(input.id)) this.conflict();
    const values = this.queueValues(input);
    const event = historyStatement(this.db, this.householdId, this.actor, 'imported', null, snapshot(values, 'pending'), sql`changes() = 1`);
    await this.db.batch([conditionalInsert(this.db, queueTable, values, this.inputUnused(input.id, 'pending')).onConflictDoNothing(), event.statement]);
    return this.requireQueueItem(input.id);
  }

  async updateQueueItem(id: string, patch: Partial<QueueInput>, expectedRevision?: number) {
    const current = await this.requireQueueItem(id);
    this.checkRevision(current, expectedRevision);
    await this.assertOwns({
      payerId: patch.payerId ?? current.payerId,
      cardId: patch.cardId !== undefined ? patch.cardId : current.cardId,
    });
    const category = patch.category !== undefined
      ? (patch.category === null ? null : canonicalCategory(patch.category))
      : (current.category === null ? null : canonicalCategory(current.category));
    const store = patch.store !== undefined ? patch.store : current.store;
    const attribution = this.attribution(current.revision + 1, current.hasBeenApproved ? undefined : current);
    const values = { ...current, ...attribution,
      lastEditedAt: current.hasBeenApproved ? attribution.updatedAt : null,
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
      if (this.assertCustomAllocation(values.splitType, values.splitRuleJson ? JSON.parse(values.splitRuleJson) : null, current)) {
        values.splitRuleJson = current.splitRuleJson;
      }
    }
    if (!changedExpenseFields(current, values).length) return current;
    const event = current.hasBeenApproved ? historyStatement(this.db, this.householdId, this.actor, 'edited', snapshot(current, 'pending'), snapshot(values, 'pending'), this.queueGuard(current)) : null;
    const gate = event ? eventExists(event.id) : sql`changes() = 1`;
    const update = this.db.update(queueTable).set(values).where(and(eq(queueTable.id, id), eq(queueTable.householdId, this.householdId), event ? gate : this.queueGuard(current)));

    const categoryChanged = patch.category !== undefined
      && category !== (current.category === null ? null : canonicalCategory(current.category));
    const statements = event ? [event.statement, update] : [update];
    if (categoryChanged && category !== null && store && normalizeMerchantName(store)) {
      statements.push(this.categoryPreferenceUpsert(store, category, gate) as never);
    }
    const results = await this.db.batch(statements as never) as D1Result[];
    if (results[0].meta.changes !== 1) this.conflict();
    return this.requireQueueItem(id);
  }

  private async pendingSplitRetry(id: string, queueItemId: string, amountCents: number, revision: number) {
    const [event] = await this.db.select().from(expenseHistory).where(and(
      eq(expenseHistory.householdId, this.householdId), eq(expenseHistory.sourceRowId, id),
      eq(expenseHistory.targetRowId, queueItemId), sql`${expenseHistory.eventType} in ('edited', 'split')`,
    )).limit(1);
    if (!event) return null;
    const before = JSON.parse(event.beforeJson!);
    const after = JSON.parse(event.afterJson);
    const rows = await this.db.select().from(queueTable).where(and(eq(queueTable.householdId, this.householdId),
      sql`${queueTable.id} in (${id}, ${queueItemId})`));
    const original = rows.find(row => row.id === id);
    const separated = rows.find(row => row.id === queueItemId);
    if (!original || !separated || before.revision !== revision || before.amountCents - after.amountCents !== amountCents
      || original.expenseId !== event.expenseId || original.revision !== event.revision || separated.revision !== 1
      || separated.parentExpenseId !== original.expenseId || separated.amountCents !== amountCents) this.conflict();
    return { original, separated };
  }

  /** Source, child and retry evidence commit together; no financial row is Approved. */
  async splitQueueItem(id: string, queueItemId: string, amountCents: number, expectedRevision: number) {
    const retry = await this.pendingSplitRetry(id, queueItemId, amountCents, expectedRevision);
    if (retry) return retry;
    const current = await this.requireQueueItem(id);
    this.checkRevision(current, expectedRevision);
    this.validatePortion(current.amountCents, amountCents);
    const attribution = this.attribution(current.revision + 1, current.hasBeenApproved ? undefined : current);
    const original = { ...current, ...attribution, amountCents: current.amountCents! - amountCents,
      lastEditedAt: current.hasBeenApproved ? attribution.updatedAt : null };
    const separated = { ...current, id: queueItemId, expenseId: crypto.randomUUID(), ...this.attribution(1),
      parentExpenseId: current.expenseId, amountCents, createdAt: attribution.updatedAt,
      lastEditedAt: current.hasBeenApproved ? attribution.updatedAt : null };
    const baseline = current.hasBeenApproved ? await this.approvalBaseline(current) : null;
    // Capture financial context now; a parent's later edits must not change the child's reapproval.
    const unchangedAllocation = baseline && (!current.splitType || (current.splitType === baseline.splitType && current.splitRuleJson === baseline.splitRuleJson));
    const capturedRule = current.splitType ? current.splitRuleJson : baseline?.splitRuleJson;
    const approvalBaseline = baseline && { amountCents: current.amountCents!, cardId: current.cardId,
      cardNameSnapshot: current.cardId === baseline.cardId ? baseline.cardNameSnapshot : await this.cardName(current.cardId),
      splitType: current.splitType ?? baseline.splitType, splitRuleJson: capturedRule ?? null,
      splitSharesJson: unchangedAllocation && current.amountCents === baseline.amountCents ? baseline.splitSharesJson
        : JSON.stringify(computeShares(current.amountCents!, (current.splitType ?? baseline.splitType) as TxInput['splitType'],
          capturedRule ? JSON.parse(capturedRule) : null,
          unchangedAllocation ? this.frozenParticipants(baseline) : await this.roster())),
      isStarred: 0, favoriteName: null };
    const guard = and(this.queueGuard(current), this.inputUnused(queueItemId, 'pending'),
      sql`not exists (select 1 from ${queueTable} where ${queueTable.id} = ${queueItemId})`,
      sql`not exists (select 1 from ${transactions} where ${transactions.id} = ${queueItemId})`)!;
    const event = historyStatement(this.db, this.householdId, this.actor, current.hasBeenApproved ? 'edited' : 'split',
      snapshot(current, 'pending'), snapshot(original, 'pending'), guard, id, queueItemId);
    const gate = eventExists(event.id);
    const [result] = await this.db.batch([
      event.statement,
      this.db.update(queueTable).set(original).where(and(eq(queueTable.id, id), eq(queueTable.householdId, this.householdId), gate)),
      conditionalInsert(this.db, queueTable, separated, gate),
      historyStatement(this.db, this.householdId, this.actor, 'created', null,
        snapshot({ ...separated, ...(approvalBaseline ? { approvalBaseline } : {}) }, 'pending'), gate, id, queueItemId).statement,
    ]);
    if (result.meta.changes !== 1) {
      const concurrent = await this.pendingSplitRetry(id, queueItemId, amountCents, expectedRevision);
      if (concurrent) return concurrent;
      this.conflict();
    }
    return { original: await this.requireQueueItem(id), separated: await this.requireQueueItem(queueItemId) };
  }

  async deleteQueueItem(id: string, expectedRevision?: number): Promise<void> {
    const current = await this.requireQueueItem(id);
    this.checkRevision(current, expectedRevision);
    const after = { ...current, ...this.attribution(current.revision + 1) };
    const event = historyStatement(this.db, this.householdId, this.actor, 'deleted', snapshot(current, 'pending'), snapshot(after, 'deleted'), this.queueGuard(current));
    const [saved] = await this.db.batch([event.statement, this.db.delete(queueTable).where(and(eq(queueTable.id, id), eq(queueTable.householdId, this.householdId), eventExists(event.id)))]);
    if (saved.meta.changes !== 1) this.conflict();
  }

  async deleteQueueItems(ids: string[], revisions?: Record<string, number>): Promise<string[]> {
    if (!ids.length) throw new HTTPException(400, { message: 'ids must not be empty' });
    const selectedIds = sql`${queueTable.id} in (select value from json_each(${JSON.stringify(ids)}))`;
    const rows = await this.db.select().from(queueTable).where(and(eq(queueTable.householdId, this.householdId), selectedIds));
    rows.forEach((row) => this.checkRevision(row, revisions?.[row.id]));
    if (revisions && rows.length !== ids.length) this.conflict();
    if (!rows.length) return [];
    // One all-row predicate makes stale bulk removal fail without partially deleting its selection.
    const versions = JSON.stringify(rows.map(({ id, expenseId, revision }) => ({ id, expenseId, revision })));
    const guard = sql`(select count(*) from json_each(${versions}) selected join ${queueTable}
      on ${queueTable.id} = json_extract(selected.value, '$.id')
      and ${queueTable.expenseId} = json_extract(selected.value, '$.expenseId')
      and ${queueTable.revision} = json_extract(selected.value, '$.revision')
      where ${queueTable.householdId} = ${this.householdId}) = ${rows.length}`;
    const events = rows.map(row => historyValues(this.householdId, this.actor, 'deleted', snapshot(row, 'pending'),
      snapshot({ ...row, ...this.attribution(row.revision + 1) }, 'deleted')));
    const [saved] = await this.db.batch([conditionalJsonInsert(this.db, expenseHistory, events, guard),
      this.db.delete(queueTable).where(and(eq(queueTable.householdId, this.householdId), selectedIds, eventExists(events[0].id)))]);
    if (saved.meta.changes !== rows.length) this.conflict();
    return ids.filter((id) => rows.some((row) => row.id === id));
  }

  /**
   * Atomic bulk import for POST /api/queue/bulk. Every row is validated
   * (structural shape is the caller's job; ownership is this method's) before
   * anything is written, so one bad row leaves zero inserted rows. Rows whose
   * id already exists are skipped rather than re-inserted — that's what makes
   * a retried upload idempotent — and are counted as `rejected`. Surviving
   * rows are written in a single db.batch, so a mid-batch failure can't leave
   * a partial import.
   *
   * Duplicate *content* (not id) is advisory: a row matching an active
   * transaction, an existing queue row, or an earlier row in this same
   * upload is still inserted, just flagged `isDuplicate` — never silently
   * dropped, per the "keep both" requirement. The match itself is exact
   * signed amount + normalized merchant name + date within
   * DUPLICATE_WINDOW_MS; if both sides name a payer or card that disagree,
   * the row is not considered a match (reduces false positives across
   * co-payers on the same day without needing either field to be present).
   */
  async insertQueueItemsBulk(items: QueueInput[]) {
    if (items.length === 0) {
      throw new HTTPException(400, { message: 'items must not be empty' });
    }
    const ids = items.map((i) => i.id);
    if (new Set(ids).size !== ids.length) {
      throw new HTTPException(400, { message: 'Duplicate id within the same upload' });
    }

    // Ownership first — throws before any write if a payer/card is unknown
    // or belongs to another household.
    await this.bulkOwnership(items);

    const [existingRows, activeTx, queueRows] = await Promise.all([
      this.db.select().from(queueTable)
        .where(and(eq(queueTable.householdId, this.householdId), sql`${queueTable.id} in (select value from json_each(${JSON.stringify(ids)}))`)),
      this.activeTransactions(),
      this.queueItems(),
    ]);
    const existingIds = new Set([...existingRows.map((r) => r.id), ...await this.consumedInputIds(ids, 'pending')]);
    const toInsert = items.filter((item) => !existingIds.has(item.id));

    const duplicateOf = new Map<string, boolean>();
    toInsert.forEach((item, i) => {
      const matchesTx = activeTx.some((t) => isDuplicateMatch(item, t));
      const matchesQueue = queueRows.some((q) => isDuplicateMatch(item, q));
      const matchesSibling = toInsert.slice(0, i).some((sib) => isDuplicateMatch(item, sib));
      duplicateOf.set(item.id, Boolean(item.isDuplicate) || matchesTx || matchesQueue || matchesSibling);
    });

    const values = toInsert.map(item => ({ ...this.queueValues(item), isDuplicate: duplicateOf.get(item.id) ? 1 : 0 }));
    const events = values.map(value => historyValues(this.householdId, this.actor, 'imported', null, snapshot(value, 'pending')));
    const unused = sql`not exists (select 1 from ${expenseHistory} where ${expenseHistory.householdId} = ${this.householdId}
      and ${expenseHistory.beforeJson} is null and json_extract(${expenseHistory.afterJson}, '$.state') = 'pending'
      and json_extract(${expenseHistory.afterJson}, '$.id') = json_extract(imported.value, '$.id'))`;
    const createdGuard = sql`exists (select 1 from ${queueTable} where ${queueTable.householdId} = ${this.householdId}
      and ${queueTable.expenseId} = json_extract(imported.value, '$.expenseId'))`;
    const results = values.length ? await this.db.batch([
      conditionalJsonInsert(this.db, queueTable, values, unused).returning(),
      conditionalJsonInsert(this.db, expenseHistory, events, createdGuard),
    ]) : [];
    // RETURNING reports rows this batch inserted, even if another request moves them before the response.
    const saved = results.length ? results[0] as Array<typeof queueTable.$inferSelect> : [];
    const created = values.flatMap(value => saved.filter(row => row.id === value.id));
    return {
      created,
      inserted: created.length,
      duplicate: created.filter((row) => row.isDuplicate).length,
      rejected: items.length - created.length,
    };
  }

  /**
   * Atomic bulk apply for the "Suggest Categories" accept flow (Phase 6).
   * Every UPDATE is scoped to this household's still-active, undeleted,
   * still-`Other` rows, so a suggestion made stale since preview — the row
   * was recategorized, deleted, or claimed into a cycle in the meantime —
   * is silently skipped rather than clobbering someone else's change. All
   * statements run in one db.batch (one D1 transaction), matching the
   * pattern closeCycle uses for its own guarded multi-row update.
   */
  async applyCategorySuggestions(updates: { id: string; category: string; revision?: number }[]): Promise<{ applied: string[]; skipped: string[] }> {
    if (!updates.length) return { applied: [], skipped: [] };
    if (new Set(updates.map((u) => u.id)).size !== updates.length) throw new HTTPException(400, { message: 'Duplicate id in category suggestion batch' });
    const rows = await this.activeTransactions();
    const now = Date.now();
    const candidates = updates.flatMap((u) => {
      const current = rows.find((row) => row.id === u.id && row.category === 'Other' && (u.revision === undefined || row.revision === u.revision));
      if (!current) return [];
      const category = canonicalCategory(u.category);
      if (category === current.category) return [];
      const after = { ...current, ...this.attribution(current.revision + 1), category, updatedAt: now, lastEditedAt: now };
      const event = historyValues(this.householdId, this.actor, 'category_suggestion', snapshot(current, 'approved'), snapshot(after, 'approved'));
      return [{ id: u.id, after, event }];
    });
    if (!candidates.length) return { applied: [], skipped: updates.map((u) => u.id) };
    const currentGuard = sql`exists (select 1 from ${transactions} where ${transactions.householdId} = ${this.householdId}
      and ${transactions.id} = json_extract(json_extract(imported.value, '$.beforeJson'), '$.id')
      and ${transactions.expenseId} = json_extract(imported.value, '$.expenseId')
      and ${transactions.revision} = json_extract(imported.value, '$.revision') - 1
      and ${transactions.category} = 'Other' and ${transactions.cycleId} is null and ${transactions.deletedAt} is null)`;
    const events = candidates.map(candidate => candidate.event);
    const accepted = sql`exists (select 1 from ${expenseHistory} where ${expenseHistory.id} in
      (select value from json_each(${JSON.stringify(events.map(event => event.id))}))
      and ${expenseHistory.householdId} = ${this.householdId} and ${expenseHistory.expenseId} = ${transactions.expenseId}
      and ${expenseHistory.revision} = ${transactions.revision} + 1)`;
    const category = sql`(select json_extract(value, '$.category') from json_each(${JSON.stringify(candidates.map(candidate => ({ id: candidate.id, category: candidate.after.category })))})
      where json_extract(value, '$.id') = ${transactions.id})`;
    const results = await this.db.batch([
      conditionalJsonInsert(this.db, expenseHistory, events, currentGuard),
      this.db.update(transactions).set({ category, revision: sql`${transactions.revision} + 1`,
        editedByMemberId: this.actor?.memberId ?? null, editedByName: this.actor?.displayName ?? null,
        updatedAt: now, lastEditedAt: now }).where(and(eq(transactions.householdId, this.householdId), accepted)).returning({ id: transactions.id }),
    ]);
    const saved = results[1] as Array<{ id: string }>;
    const applied = candidates.filter(candidate => saved.some(row => row.id === candidate.id)).map(candidate => candidate.id);
    return { applied, skipped: updates.filter((u) => !applied.includes(u.id)).map((u) => u.id) };
  }

  async categoryPreferences(): Promise<Record<string, string>> {
    const preferenceRows = await this.db.select().from(categoryPreferences)
      .where(eq(categoryPreferences.householdId, this.householdId));
    const result: Record<string, string> = {};
    for (const row of preferenceRows) result[row.storeKey] = canonicalCategory(row.category);
    return result;
  }

  private categoryPreferenceUpsert(store: string, category: string, guard: SQL = sql`1`) {
    const storeKey = normalizeMerchantName(store);
    return conditionalInsert(this.db, categoryPreferences, {
      householdId: this.householdId,
      storeKey,
      category: canonicalCategory(category),
      updatedAt: Date.now(),
    }, guard).onConflictDoUpdate({
      target: [categoryPreferences.householdId, categoryPreferences.storeKey],
      set: { category: canonicalCategory(category), updatedAt: Date.now() },
    });
  }

  private async transitionRetry(eventType: string, sourceRowId: string, targetRowId?: string, expectedRevision?: number) {
    const events = await this.db.select().from(expenseHistory).where(and(
      eq(expenseHistory.householdId, this.householdId), eq(expenseHistory.eventType, eventType), eq(expenseHistory.sourceRowId, sourceRowId),
      targetRowId ? eq(expenseHistory.targetRowId, targetRowId) : undefined,
      expectedRevision !== undefined ? eq(expenseHistory.revision, expectedRevision + 1) : undefined,
    )).orderBy(desc(expenseHistory.timestamp), desc(expenseHistory.revision)).limit(1);
    if (!events.length) return null;
    const event = events[0];
    const table = eventType === 'approved' ? transactions : queueTable;
    const rows = await this.db.select().from(table).where(and(eq(table.householdId, this.householdId), eq(table.id, event.targetRowId!), eq(table.expenseId, event.expenseId), eq(table.revision, event.revision))).limit(1);
    if (!rows.length || ('deletedAt' in rows[0] && rows[0].deletedAt !== null)) this.conflict();
    return rows[0];
  }

  async confirmQueueItem(queueId: string, transactionId: string, input: TxInput, expectedRevision?: number) {
    const retry = await this.transitionRetry('approved', queueId, transactionId, expectedRevision);
    if (retry) return retry as typeof transactions.$inferSelect;
    const current = await this.requireQueueItem(queueId);
    this.checkRevision(current, expectedRevision);
    // Saved Pending allocation is the default; the approval body can supply outstanding draft edits.
    const splitRule = input.splitRule ?? (input.splitType === current.splitType && current.splitRuleJson ? JSON.parse(current.splitRuleJson) : null);
    const values = { ...await this.transactionValues({ ...input, splitRule, id: transactionId }, undefined, current),
      expenseId: current.expenseId, ...this.attribution(current.revision + 1, current), source: current.source,
      hasBeenApproved: true, lastEditedAt: current.lastEditedAt, parentExpenseId: current.parentExpenseId,
      sourceFileId: current.sourceFileId, sourceFileName: current.sourceFileName,
      reviewNote: current.reviewNote, createdAt: current.createdAt };
    const previous = current.hasBeenApproved ? await this.approvalBaseline(current) : null;
    if (previous) {
      if (values.cardId === previous.cardId) values.cardNameSnapshot = previous.cardNameSnapshot;
      if (input.isStarred === undefined) values.isStarred = previous.isStarred;
      if (input.favoriteName === undefined) values.favoriteName = previous.favoriteName;
      if (values.splitType === previous.splitType && values.splitRuleJson === previous.splitRuleJson) {
        const frozen = this.frozenParticipants(previous);
        values.splitSharesJson = values.amountCents === previous.amountCents ? previous.splitSharesJson
          : JSON.stringify(computeShares(values.amountCents, input.splitType, splitRule, frozen));
      }
    }
    const event = historyStatement(this.db, this.householdId, this.actor, 'approved', snapshot(current, 'pending'), snapshot(values, 'approved'), this.queueGuard(current), queueId, transactionId);
    const [saved] = await this.db.batch([event.statement,
      conditionalInsert(this.db, transactions, values, eventExists(event.id)),
      this.db.delete(queueTable).where(and(eq(queueTable.id, queueId), eq(queueTable.householdId, this.householdId), eventExists(event.id)))]);
    if (saved.meta.changes !== 1) {
      const concurrent = await this.transitionRetry('approved', queueId, transactionId, expectedRevision);
      if (concurrent) return concurrent as typeof transactions.$inferSelect;
      this.conflict();
    }
    return this.requireTransaction(transactionId);
  }

  async returnToPending(id: string, expectedRevision: number, note?: string) {
    const retry = await this.transitionRetry('returned_to_pending', id, undefined, expectedRevision);
    if (retry) return retry as typeof queueTable.$inferSelect;
    const current = await this.requireTransaction(id);
    this.checkRevision(current, expectedRevision);
    if (current.cycleId || current.deletedAt) this.conflict();
    const values = { id: current.expenseId, householdId: this.householdId, expenseId: current.expenseId,
      ...this.attribution(current.revision + 1, current), date: current.date, store: current.store,
      hasBeenApproved: true, lastEditedAt: current.lastEditedAt, parentExpenseId: current.parentExpenseId,
      amountCents: current.amountCents, category: current.category, payerId: current.payerId, cardId: current.cardId,
      splitType: current.splitType, splitRuleJson: current.splitRuleJson, isDuplicate: 0,
      source: current.source, sourceFileId: current.sourceFileId, sourceFileName: current.sourceFileName,
      createdAt: current.createdAt, reviewNote: note === undefined ? current.reviewNote : note.trim() || null };
    const event = historyStatement(this.db, this.householdId, this.actor, 'returned_to_pending', snapshot(current, 'approved'), snapshot(values, 'pending'), this.transactionGuard(current), id, values.id);
    const [saved] = await this.db.batch([event.statement, conditionalInsert(this.db, queueTable, values, eventExists(event.id)),
      this.db.delete(transactions).where(and(eq(transactions.id, id), eq(transactions.householdId, this.householdId), eventExists(event.id)))]);
    if (saved.meta.changes !== 1) {
      const concurrent = await this.transitionRetry('returned_to_pending', id, undefined, expectedRevision);
      if (concurrent) return concurrent as typeof queueTable.$inferSelect;
      this.conflict();
    }
    return this.requireQueueItem(values.id);
  }

  private async approvalBaseline(current: typeof queueTable.$inferSelect): Promise<ApprovalBaseline> {
    const [event] = await this.db.select().from(expenseHistory).where(and(
      eq(expenseHistory.householdId, this.householdId), eq(expenseHistory.expenseId, current.expenseId),
      sql`(${expenseHistory.eventType} = 'returned_to_pending' or json_type(${expenseHistory.afterJson}, '$.approvalBaseline') = 'object')`,
    )).orderBy(desc(expenseHistory.revision)).limit(1);
    if (!event) this.conflict();
    return event.eventType === 'returned_to_pending' ? JSON.parse(event.beforeJson!) : JSON.parse(event.afterJson).approvalBaseline;
  }

  private expenseLineage(expenseId: string) {
    return sql`with recursive lineage(expense_id, max_revision) as (
      select ${expenseId}, null union select parent.expense_id, parent.revision
      from lineage cross join ${expenseHistory} child cross join ${expenseHistory} parent
        on parent.household_id = child.household_id and parent.target_row_id = json_extract(child.after_json, '$.id')
        and parent.source_row_id = child.source_row_id and parent.expense_id <> child.expense_id
        and parent.event_type in ('edited', 'split')
      where child.expense_id = lineage.expense_id and child.household_id = ${this.householdId} and child.before_json is null
        and (lineage.max_revision is null or child.revision <= lineage.max_revision)
    ) select expense_id, max_revision from lineage`;
  }

  async expenseHistory(expenseId: string) {
    // Cross joins pin SQLite's join order to walk from the lineage through indexes; otherwise it pairs every history row (N²).
    const rows = await this.db.select(getTableColumns(expenseHistory)).from(sql`(${this.expenseLineage(expenseId)}) ancestor`)
      .crossJoin(expenseHistory).where(and(eq(expenseHistory.householdId, this.householdId), sql`${expenseHistory.expenseId} = ancestor.expense_id`,
        sql`(ancestor.max_revision is null or ${expenseHistory.revision} <= ancestor.max_revision)`))
      .orderBy(desc(expenseHistory.timestamp), desc(expenseHistory.revision));
    if (!rows.length) throw new HTTPException(404, { message: 'Expense history not found' });
    return rows.map(publicHistory);
  }

  /**
   * onConflictDoUpdate below targets the primary key alone, so a crafted id
   * that already exists in another household would otherwise update that
   * row in place (not move it, but silently rename/reorder it from here).
   * This check closes that cross-tenant write before the upsert runs.
   */
  private async assertIdFree(
    table: typeof householdMembers | typeof cards,
    id: string,
    label: string,
  ): Promise<void> {
    const rows = await this.db.select({ householdId: table.householdId }).from(table)
      .where(eq(table.id, id)).limit(1);
    if (rows.length > 0 && rows[0].householdId !== this.householdId) {
      throw new HTTPException(403, { message: `${label} id belongs to another household` });
    }
  }

  async upsertMember(input: {
    id: string; displayName: string; sortOrder?: number; role?: 'owner' | 'member';
  }) {
    await this.assertIdFree(householdMembers, input.id, 'Member');
    await this.db.insert(householdMembers).values({
      id: input.id,
      householdId: this.householdId,
      displayName: input.displayName,
      sortOrder: input.sortOrder ?? 0,
      role: input.role ?? 'member',
      createdAt: Date.now(),
    }).onConflictDoUpdate({
      target: householdMembers.id,
      set: { displayName: input.displayName, sortOrder: input.sortOrder },
    });
    const rows = await this.db.select().from(householdMembers).where(and(
      eq(householdMembers.id, input.id),
      eq(householdMembers.householdId, this.householdId),
    )).limit(1);
    return rows[0];
  }

  /** Participants in history are archived, never deleted. */
  async archiveMember(id: string): Promise<void> {
    const pending = await this.db.select({ id: queueTable.id }).from(queueTable).where(and(
      eq(queueTable.householdId, this.householdId),
      eq(queueTable.payerId, id),
    ));
    if (pending.length > 0) {
      throw new HTTPException(409, {
        message: 'Resolve this participant\'s queued items before archiving them',
      });
    }
    const member = and(eq(householdMembers.id, id), eq(householdMembers.householdId, this.householdId));
    const [row] = await this.db.select({ role: householdMembers.role }).from(householdMembers).where(member).limit(1);
    if (!row) throw new HTTPException(404, { message: 'Member not found' });
    if (row.role === 'owner') throw new HTTPException(409, { message: 'The household owner cannot be removed' });
    // Their cards go too, so pickers and statement reminders drop them; expenses keep the card name snapshot.
    await this.db.batch([
      this.db.update(householdMembers).set({ archivedAt: Date.now() }).where(member),
      this.db.update(cards).set({ archived: 1 })
        .where(and(eq(cards.memberId, id), eq(cards.householdId, this.householdId))),
    ]);
  }

  async upsertCard(input: {
    id: string; memberId: string; name: string; sortOrder?: number;
    statementDay?: number | null; applyToHistory?: boolean;
  }) {
    await this.assertOwns({ payerId: input.memberId });
    await this.assertIdFree(cards, input.id, 'Card');
    await this.db.insert(cards).values({
      id: input.id,
      householdId: this.householdId,
      memberId: input.memberId,
      name: input.name,
      sortOrder: input.sortOrder ?? 0,
      archived: 0,
      statementDay: input.statementDay,
    }).onConflictDoUpdate({
      target: cards.id,
      set: {
        name: input.name, sortOrder: input.sortOrder, statementDay: input.statementDay,
        // Display metadata only: closed-cycle rows and their snapshots stay untouched.
        ...(input.applyToHistory && {
          historyName: input.name,
          historyStatementDay: input.statementDay === undefined ? sql`${cards.statementDay}` : input.statementDay,
          historyAppliedAt: Date.now(),
        }),
      },
    });
    const rows = await this.db.select().from(cards)
      .where(and(eq(cards.id, input.id), eq(cards.householdId, this.householdId))).limit(1);
    return rows[0];
  }

  /** Closed cycles and expenses whose displayed card label or statement day a retrospective save would change. */
  async cardHistoryScope(input: { id: string; name: string; statementDay?: number | null }) {
    const card = (await this.cards()).find((c) => c.id === input.id);
    if (!card) throw new HTTPException(404, { message: 'Card not found' });
    const day = input.statementDay === undefined ? card.statementDay : input.statementDay;
    const rows = await this.db.select({ cycleId: transactions.cycleId, label: transactions.cardNameSnapshot, closedAt: cycles.closedAt })
      .from(transactions).innerJoin(cycles, eq(cycles.id, transactions.cycleId)).where(and(
        eq(transactions.householdId, this.householdId),
        eq(transactions.cardId, input.id),
        isNotNull(transactions.cycleId),
        isNull(transactions.deletedAt),
      ));
    const affected = rows.filter((row) => {
      const shown = closedCycleCard(card, row.closedAt, row.label);
      return shown.name !== input.name || shown.statementDay !== day;
    });
    return { cycles: new Set(affected.map((row) => row.cycleId)).size, expenses: affected.length };
  }

  /** Sets sort_order to each id's position; every id must belong to this household. */
  async reorder(kind: 'members' | 'cards', ids: string[]): Promise<void> {
    const table = kind === 'members' ? householdMembers : cards;
    const scoped = (id?: string) => and(eq(table.householdId, this.householdId), id === undefined ? inArray(table.id, ids) : eq(table.id, id));
    const owned = await this.db.select({ id: table.id }).from(table).where(scoped());
    if (owned.length !== ids.length) throw new HTTPException(403, { message: `Unknown ${kind === 'members' ? 'member' : 'card'}` });
    await this.db.batch(ids.map((id, sortOrder) => this.db.update(table).set({ sortOrder }).where(scoped(id))) as never);
  }

  /** Cards are archived so historical rows stay readable after a rename. */
  async archiveCard(id: string): Promise<void> {
    const result = await this.db.update(cards).set({ archived: 1 })
      .where(and(eq(cards.id, id), eq(cards.householdId, this.householdId)));
    if (result.meta.changes !== 1) throw new HTTPException(404, { message: 'Card not found' });
  }

  /** One month's ticks, or every month's when month is omitted (export). */
  async reminderCompletions(month?: string) {
    const { householdId: _, ...columns } = getTableColumns(reminderCompletions);
    return this.db.select(columns).from(reminderCompletions).where(and(
      eq(reminderCompletions.householdId, this.householdId),
      month === undefined ? undefined : eq(reminderCompletions.month, month),
    ));
  }

  /** Manual, reversible calendar tick. Never touches approval, cycles or payment status. */
  async setReminderCompletion(month: string, reminderId: string, done: boolean) {
    if (reminderId.startsWith('card:')) await this.assertOwns({ cardId: reminderId.slice(5) });
    const key = and(
      eq(reminderCompletions.householdId, this.householdId),
      eq(reminderCompletions.month, month), eq(reminderCompletions.reminderId, reminderId),
    );
    if (!done) await this.db.delete(reminderCompletions).where(key);
    else await this.db.insert(reminderCompletions).values({
      householdId: this.householdId, month, reminderId,
      completedByMemberId: this.actor?.memberId ?? null, completedAt: Date.now(),
    }).onConflictDoNothing();
    return this.reminderCompletions(month);
  }

  async updateHousehold(patch: {
    name?: string; customCategories?: string[]; allowedEmails?: AllowlistEntry[];
  }) {
    const current = await this.household();
    await this.db.update(households).set({
      name: patch.name ?? current.name,
      customCategoriesJson: patch.customCategories
        ? JSON.stringify([...new Set(patch.customCategories.map(canonicalCategory))])
        : current.customCategoriesJson,
      allowedEmailsJson: patch.allowedEmails
        ? JSON.stringify(patch.allowedEmails) : current.allowedEmailsJson,
    }).where(eq(households.id, this.householdId));
    return this.household();
  }

  /** Returns false when the household is over its daily AI-usage allowance. */
  async checkAiQuota(usageDate: string, limit = DAILY_AI_LIMIT): Promise<boolean> {
    return checkAndIncrement(this.db, this.householdId, usageDate, limit);
  }

  /** Full dump for the Download my data button. Auth tables are never included. */
  async exportAll() {
    const [household, members, cardRows, active, archived, cycleRows, prefs, queue, reminders, history] =
      await Promise.all([
        this.household(), this.publicMembers(), this.cards(),
        this.activeTransactions(), this.archivedTransactions(),
        this.cycles(), this.categoryPreferences(), this.queueItems(), this.reminderCompletions(),
        this.db.select().from(expenseHistory).where(eq(expenseHistory.householdId, this.householdId)).orderBy(desc(expenseHistory.timestamp), desc(expenseHistory.revision)),
      ]);
    return {
      exportedAt: Date.now(),
      household: { ...household, allowedEmailsJson: undefined },
      members,
      cards: cardRows,
      transactions: [...active, ...archived],
      cycles: cycleRows,
      categoryPreferences: prefs,
      queue,
      reminderCompletions: reminders,
      expenseHistory: history.map(publicHistory),
    };
  }
}

export interface Scope {
  householdId: string;
  memberId: string;
  role: 'owner' | 'member';
  repo: ScopedRepository;
}

/** Matches resolveSignIn's normalization: trimmed, case-insensitive. */
function isEmailAllowed(email: string, allowedEmailsJson: string, ownerEmail: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (normalized === ownerEmail.trim().toLowerCase()) return true;
  const allowlist: AllowlistEntry[] = JSON.parse(allowedEmailsJson);
  return allowlist.some((e) => e.email.trim().toLowerCase() === normalized);
}

/** The group the client names for this request, if any. An empty value names none. */
function requestedGroup(c: Context<{ Bindings: Env }>): string | undefined {
  return c.req.header('x-divvy-group') || c.req.query('group') || undefined;
}

// The /api/* middleware and then the handler both call requireScope; one
// resolution per request serves both.
const scopes = new WeakMap<Request, Promise<Scope>>();

export function requireScope(c: Context<{ Bindings: Env }>): Promise<Scope> {
  let scope = scopes.get(c.req.raw);
  if (!scope) {
    scope = resolveScope(c);
    scopes.set(c.req.raw, scope);
  }
  return scope;
}

async function resolveScope(c: Context<{ Bindings: Env }>): Promise<Scope> {
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) throw new HTTPException(401, { message: 'Not signed in' });

  const db = drizzle(c.env.DB);
  const group = requestedGroup(c);
  const rows = await db
    .select(getTableColumns(householdMembers)).from(memberAccounts)
    .innerJoin(householdMembers, eq(householdMembers.id, memberAccounts.memberId))
    .where(and(
      eq(memberAccounts.userId, session.user.id),
      group === undefined ? undefined : eq(memberAccounts.householdId, group),
    ))
    // Active links first: two rows that are both active mean the caller must choose.
    .orderBy(sql`${householdMembers.archivedAt} is not null`)
    .limit(2);

  if (rows.length === 0) throw new HTTPException(403, { message: 'No household membership' });
  if (rows.filter((r) => r.archivedAt === null).length > 1) {
    throw new HTTPException(400, {
      res: Response.json({ error: 'Choose a group', reason: 'group_required' }, { status: 400 }),
    });
  }

  const member = rows[0];
  if (member.archivedAt !== null) throw new HTTPException(403, { message: 'Removed from this household' });
  const repo = new ScopedRepository(db, member.householdId, { memberId: member.id, displayName: member.displayName });

  // Every later sign-in (and every later request) must still match the
  // household's allowlist. The Better Auth hook only gates account
  // *creation*, so a removal from the allowlist would otherwise never take
  // effect for an already-created account. This is the enforcement point.
  const household = await repo.household();
  if (!isEmailAllowed(session.user.email, household.allowedEmailsJson, c.env.OWNER_EMAIL)) {
    throw new HTTPException(403, { message: 'No longer permitted' });
  }

  return {
    householdId: member.householdId,
    memberId: member.id,
    role: member.role as 'owner' | 'member',
    repo,
  };
}

export function requireOwner(scope: Scope): void {
  if (scope.role !== 'owner') {
    throw new HTTPException(403, { message: 'Owner only' });
  }
}
