CREATE TABLE `expense_history` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`expense_id` text NOT NULL,
	`revision` integer NOT NULL,
	`event_type` text NOT NULL,
	`actor_member_id` text,
	`actor_name` text,
	`timestamp` integer NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`review_note` text,
	`source_row_id` text,
	`target_row_id` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `history_expense_revision_idx` ON `expense_history` (`household_id`,`expense_id`,`revision`);--> statement-breakpoint
ALTER TABLE `queue_items` ADD `expense_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `edited_by_member_id` text;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `edited_by_name` text;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `review_note` text;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `split_rule_json` text;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `expense_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `edited_by_member_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `edited_by_name` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `review_note` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `source` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `source_file_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `source_file_name` text;--> statement-breakpoint
--> statement-breakpoint
UPDATE transactions SET expense_id = 'tx:' || id;
--> statement-breakpoint
UPDATE queue_items SET expense_id = 'queue:' || id, updated_at = created_at;
--> statement-breakpoint
CREATE UNIQUE INDEX `queue_expense_idx` ON `queue_items` (`expense_id`);--> statement-breakpoint
--> statement-breakpoint
CREATE UNIQUE INDEX `tx_expense_idx` ON `transactions` (`expense_id`);
--> statement-breakpoint
INSERT INTO expense_history (id, household_id, expense_id, revision, event_type, timestamp, after_json)
SELECT 'baseline:' || expense_id, household_id, expense_id, revision, 'legacy_baseline', updated_at,
json_object('state', CASE WHEN deleted_at IS NOT NULL THEN 'deleted' ELSE 'approved' END, 'expenseId', expense_id, 'revision', revision, 'editedByMemberId', edited_by_member_id, 'editedByName', edited_by_name, 'reviewNote', review_note, 'source', source, 'sourceFileId', source_file_id, 'sourceFileName', source_file_name, 'id', id, 'cycleId', cycle_id, 'date', date, 'store', store, 'amountCents', amount_cents, 'category', category, 'payerId', payer_id, 'cardId', card_id, 'cardNameSnapshot', card_name_snapshot, 'splitType', split_type, 'splitRuleJson', split_rule_json, 'splitSharesJson', split_shares_json, 'isStarred', is_starred, 'favoriteName', favorite_name, 'createdAt', created_at, 'updatedAt', updated_at, 'deletedAt', deleted_at) FROM transactions;
--> statement-breakpoint
INSERT INTO expense_history (id, household_id, expense_id, revision, event_type, timestamp, after_json)
SELECT 'baseline:' || expense_id, household_id, expense_id, revision, 'legacy_baseline', created_at,
json_object('state', 'pending', 'expenseId', expense_id, 'revision', revision, 'editedByMemberId', edited_by_member_id, 'editedByName', edited_by_name, 'reviewNote', review_note, 'splitRuleJson', split_rule_json, 'updatedAt', updated_at, 'sourceFileId', source_file_id, 'sourceFileName', source_file_name, 'id', id, 'date', date, 'store', store, 'amountCents', amount_cents, 'category', category, 'payerId', payer_id, 'cardId', card_id, 'splitType', split_type, 'isDuplicate', is_duplicate, 'source', source, 'createdAt', created_at) FROM queue_items;
