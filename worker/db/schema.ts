import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const households = sqliteTable('households', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  currencyCode: text('currency_code').notNull().default('CAD'),
  timezone: text('timezone').notNull().default('America/Vancouver'),
  customCategoriesJson: text('custom_categories_json').notNull().default('[]'),
  allowedEmailsJson: text('allowed_emails_json').notNull().default('[]'),
  // Name the user gave the open cycle; closeCycle moves it to cycles.name.
  currentCycleName: text('current_cycle_name'),
  rentReminder: integer('rent_reminder').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});

export const householdMembers = sqliteTable('household_members', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  userId: text('user_id').unique(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull().default('member'),
  sortOrder: integer('sort_order').notNull().default(0),
  archivedAt: integer('archived_at'),
  sittingOutAt: integer('sitting_out_at'),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('members_household_idx').on(t.householdId)]);

export const memberAccounts = sqliteTable('member_accounts', {
  memberId: text('member_id').primaryKey().references(() => householdMembers.id, { onDelete: 'cascade' }),
  householdId: text('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  linkedAt: integer('linked_at').notNull(),
}, (t) => [uniqueIndex('member_accounts_group_user_idx').on(t.householdId, t.userId), index('member_accounts_user_idx').on(t.userId)]);

export const cards = sqliteTable('cards', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  memberId: text('member_id').notNull().references(() => householdMembers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  archived: integer('archived').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  statementDay: integer('statement_day'),
  // Opt-in closed-cycle display overrides; transaction snapshots are never rewritten.
  historyName: text('history_name'),
  historyStatementDay: integer('history_statement_day'),
  historyAppliedAt: integer('history_applied_at'),
}, (t) => [index('cards_household_idx').on(t.householdId)]);

export const cycles = sqliteTable('cycles', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('closed'),
  settlementJson: text('settlement_json'),
  closedByMemberId: text('closed_by_member_id'),
  closedByName: text('closed_by_name'),
  closingSnapshotJson: text('closing_snapshot_json'),
  closedAt: integer('closed_at').notNull(),
  settledAt: integer('settled_at'),
  // Null shows the default label; set only after the user renames the cycle.
  name: text('name'),
}, (t) => [index('cycles_household_idx').on(t.householdId)]);

export const transactions = sqliteTable('transactions', {
  expenseId: text('expense_id').notNull().default(''),
  hasBeenApproved: integer('has_been_approved', { mode: 'boolean' }).notNull().default(true),
  lastEditedAt: integer('last_edited_at'),
  parentExpenseId: text('parent_expense_id'),
  revision: integer('revision').notNull().default(1),
  editedByMemberId: text('edited_by_member_id'),
  editedByName: text('edited_by_name'),
  reviewNote: text('review_note'),
  source: text('source'),
  sourceFileId: text('source_file_id'),
  sourceFileName: text('source_file_name'),
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  cycleId: text('cycle_id').references(() => cycles.id, { onDelete: 'set null' }),
  date: text('date').notNull(),
  store: text('store').notNull(),
  amountCents: integer('amount_cents').notNull(),
  category: text('category').notNull(),
  payerId: text('payer_id').notNull().references(() => householdMembers.id),
  cardId: text('card_id').references(() => cards.id, { onDelete: 'set null' }),
  cardNameSnapshot: text('card_name_snapshot'),
  splitType: text('split_type').notNull(),
  splitRuleJson: text('split_rule_json'),
  splitSharesJson: text('split_shares_json').notNull(),
  isStarred: integer('is_starred').notNull().default(0),
  favoriteName: text('favorite_name'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
}, (table) => [
  uniqueIndex('tx_expense_idx').on(table.expenseId),
  index('tx_scope_idx').on(table.householdId, table.cycleId, table.date),
]);

export const queueItems = sqliteTable('queue_items', {
  expenseId: text('expense_id').notNull().default(''),
  hasBeenApproved: integer('has_been_approved', { mode: 'boolean' }).notNull().default(false),
  lastEditedAt: integer('last_edited_at'),
  parentExpenseId: text('parent_expense_id'),
  revision: integer('revision').notNull().default(1),
  editedByMemberId: text('edited_by_member_id'),
  editedByName: text('edited_by_name'),
  reviewNote: text('review_note'),
  splitRuleJson: text('split_rule_json'),
  updatedAt: integer('updated_at').notNull().default(0),
  sourceFileId: text('source_file_id'),
  sourceFileName: text('source_file_name'),
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  date: text('date'),
  store: text('store'),
  amountCents: integer('amount_cents'),
  category: text('category'),
  payerId: text('payer_id'),
  cardId: text('card_id'),
  splitType: text('split_type'),
  isDuplicate: integer('is_duplicate').notNull().default(0),
  source: text('source'),
  createdAt: integer('created_at').notNull(),
}, (table) => [uniqueIndex('queue_expense_idx').on(table.expenseId), index('queue_household_idx').on(table.householdId)]);

export const expenseHistory = sqliteTable('expense_history', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  expenseId: text('expense_id').notNull(),
  revision: integer('revision').notNull(),
  eventType: text('event_type').notNull(),
  actorMemberId: text('actor_member_id'),
  actorName: text('actor_name'),
  timestamp: integer('timestamp').notNull(),
  beforeJson: text('before_json'),
  afterJson: text('after_json').notNull(),
  reviewNote: text('review_note'),
  sourceRowId: text('source_row_id'),
  targetRowId: text('target_row_id'),
}, (table) => [uniqueIndex('history_expense_revision_idx').on(table.householdId, table.expenseId, table.revision),
  index('history_lineage_idx').on(table.householdId, table.targetRowId, table.sourceRowId)]);

export const categoryPreferences = sqliteTable('category_preferences', {
  householdId: text('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  storeKey: text('store_key').notNull(),
  category: text('category').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.storeKey] }),
]);

export const aiUsage = sqliteTable('ai_usage', {
  householdId: text('household_id').notNull(),
  usageDate: text('usage_date').notNull(),
  requestCount: integer('request_count').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.usageDate] }),
]);

// Manual calendar ticks; identity is `card:<cardId>` or `rent`, so statement-day edits never move them.
export const reminderCompletions = sqliteTable('reminder_completions', {
  householdId: text('household_id').notNull().references(() => households.id, { onDelete: 'cascade' }),
  month: text('month').notNull(),
  reminderId: text('reminder_id').notNull(),
  completedByMemberId: text('completed_by_member_id'),
  completedAt: integer('completed_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.householdId, table.month, table.reminderId] }),
]);
