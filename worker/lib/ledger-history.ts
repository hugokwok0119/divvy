import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { ExpenseHistoryEvent, ExpenseSnapshot } from '../../src/types';
import { expenseHistory } from '../db/schema';

export interface ExpenseActor { memberId: string; displayName: string }

/** D1 batch statements cannot interleave; this guard gates every subsequent write. */
export const eventExists = (id: string) => sql`exists (select 1 from ${expenseHistory} where ${expenseHistory.id} = ${id})`;

export function conditionalInsert<TTable extends SQLiteTable>(db: DrizzleD1Database, table: TTable, values: Record<string, unknown>, guard: SQL) {
  const columns = getTableColumns(table);
  const entries = Object.entries(columns).map(([key, column]) => {
    const value = key in values ? values[key] : column.default ?? null;
    return value instanceof Object && 'getSQL' in value ? value as SQL : sql`${typeof value === 'boolean' ? Number(value) : value}`;
  });
  return db.insert(table).select(sql`select ${sql.join(entries, sql`, `)} where ${guard}`);
}

/** Bulk selections use one JSON parameter instead of one parameter or query per row. */
export function conditionalJsonInsert<TTable extends SQLiteTable>(db: DrizzleD1Database, table: TTable, values: Record<string, unknown>[], guard: SQL) {
  const entries = Object.keys(getTableColumns(table)).map(key => sql`json_extract(imported.value, ${`$.${key}`})`);
  return db.insert(table).select(sql`select ${sql.join(entries, sql`, `)} from json_each(${JSON.stringify(values)}) imported where ${guard}`);
}

export function snapshot(row: Record<string, unknown>, state: ExpenseSnapshot['state']): ExpenseSnapshot {
  const { householdId: _householdId, ...values } = row;
  return { ...values, state } as ExpenseSnapshot;
}

const editableFields = ['date', 'store', 'amountCents', 'category', 'payerId', 'cardId',
  'cardNameSnapshot', 'splitType', 'splitRuleJson', 'splitSharesJson', 'isStarred',
  'favoriteName', 'reviewNote', 'isDuplicate'] as const;

export function changedExpenseFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  return editableFields.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function editSnapshot(values: ExpenseSnapshot, fields: readonly string[]): ExpenseSnapshot {
  const { id, expenseId, revision, state, updatedAt, reviewNote } = values;
  return { id, expenseId, revision, state, updatedAt, reviewNote,
    ...Object.fromEntries(fields.map(key => [key, values[key]])) };
}

export function historyValues(householdId: string, actor: ExpenseActor | undefined,
  eventType: ExpenseHistoryEvent['eventType'], before: ExpenseSnapshot | null, after: ExpenseSnapshot,
  sourceRowId: string | null = null, targetRowId: string | null = null) {
  if (before && (eventType === 'edited' || eventType === 'category_suggestion' || eventType === 'split')) {
    const fields = changedExpenseFields(before, after);
    before = editSnapshot(before, fields);
    after = editSnapshot(after, fields);
  }
  return { id: crypto.randomUUID(), householdId, expenseId: after.expenseId, revision: after.revision, eventType,
    actorMemberId: actor?.memberId ?? null, actorName: actor?.displayName ?? null,
    timestamp: after.updatedAt, beforeJson: before ? JSON.stringify(before) : null,
    afterJson: JSON.stringify(after), reviewNote: after.reviewNote ?? null, sourceRowId, targetRowId };
}

export function historyStatement(db: DrizzleD1Database, householdId: string, actor: ExpenseActor | undefined,
  eventType: ExpenseHistoryEvent['eventType'], before: ExpenseSnapshot | null, after: ExpenseSnapshot,
  guard: SQL, sourceRowId: string | null = null, targetRowId: string | null = null) {
  const values = historyValues(householdId, actor, eventType, before, after, sourceRowId, targetRowId);
  return { id: values.id, statement: conditionalInsert(db, expenseHistory, values, guard) };
}

export function publicHistory(row: typeof expenseHistory.$inferSelect): ExpenseHistoryEvent {
  return { id: row.id, expenseId: row.expenseId, eventType: row.eventType as ExpenseHistoryEvent['eventType'],
    actorMemberId: row.actorMemberId, actorName: row.actorName, timestamp: row.timestamp,
    before: row.beforeJson ? JSON.parse(row.beforeJson) : null, after: JSON.parse(row.afterJson), reviewNote: row.reviewNote };
}
