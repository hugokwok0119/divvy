ALTER TABLE `queue_items` ADD `has_been_approved` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `last_edited_at` integer;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `parent_expense_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `has_been_approved` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `last_edited_at` integer;--> statement-breakpoint
ALTER TABLE `transactions` ADD `parent_expense_id` text;
--> statement-breakpoint
WITH edits AS (
  SELECT edit.* FROM expense_history edit
  WHERE edit.event_type IN ('edited', 'category_suggestion') AND edit.before_json IS NOT NULL
    AND EXISTS (SELECT 1 FROM expense_history baseline
      WHERE baseline.household_id = edit.household_id AND baseline.expense_id = edit.expense_id
        AND baseline.revision <= edit.revision
        AND (json_extract(baseline.after_json, '$.state') = 'approved'
          OR json_extract(baseline.before_json, '$.state') = 'approved'))
    AND EXISTS (SELECT 1 FROM json_each('["date","store","amountCents","category","payerId","cardId","cardNameSnapshot","splitType","splitRuleJson","splitSharesJson","isStarred","favoriteName","reviewNote","isDuplicate"]') field
      WHERE json_extract(edit.before_json, '$.' || field.value) IS NOT json_extract(edit.after_json, '$.' || field.value))
), lineage AS (
  SELECT child.household_id, child.expense_id, parent.expense_id AS parent_expense_id
  FROM expense_history child JOIN expense_history parent
    ON parent.household_id = child.household_id
    AND parent.target_row_id = json_extract(child.after_json, '$.id')
    AND parent.event_type = 'edited' AND parent.source_row_id IS NOT NULL
    AND parent.expense_id <> child.expense_id
  WHERE child.before_json IS NULL
)
UPDATE transactions AS current SET
  has_been_approved = 1,
  last_edited_at = (SELECT timestamp FROM edits WHERE household_id = current.household_id AND expense_id = current.expense_id ORDER BY revision DESC LIMIT 1),
  edited_by_member_id = CASE WHEN EXISTS (SELECT 1 FROM edits WHERE household_id = current.household_id AND expense_id = current.expense_id)
    THEN (SELECT actor_member_id FROM edits WHERE household_id = current.household_id AND expense_id = current.expense_id ORDER BY revision DESC LIMIT 1) ELSE edited_by_member_id END,
  edited_by_name = CASE WHEN EXISTS (SELECT 1 FROM edits WHERE household_id = current.household_id AND expense_id = current.expense_id)
    THEN (SELECT actor_name FROM edits WHERE household_id = current.household_id AND expense_id = current.expense_id ORDER BY revision DESC LIMIT 1) ELSE edited_by_name END,
  parent_expense_id = (SELECT parent_expense_id FROM lineage WHERE household_id = current.household_id AND expense_id = current.expense_id LIMIT 1);
--> statement-breakpoint
-- Older application inserts omit these columns during stage transitions.
CREATE TRIGGER preserve_pending_lineage AFTER INSERT ON queue_items
WHEN EXISTS (SELECT 1 FROM transactions WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id)
BEGIN
  UPDATE queue_items SET has_been_approved = 1,
    last_edited_at = (SELECT last_edited_at FROM transactions WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1),
    parent_expense_id = (SELECT parent_expense_id FROM transactions WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1),
    edited_by_member_id = CASE WHEN (SELECT last_edited_at FROM transactions WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1) IS NOT NULL
      THEN (SELECT edited_by_member_id FROM transactions WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1) ELSE edited_by_member_id END,
    edited_by_name = CASE WHEN (SELECT last_edited_at FROM transactions WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1) IS NOT NULL
      THEN (SELECT edited_by_name FROM transactions WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1) ELSE edited_by_name END
    WHERE id = NEW.id AND household_id = NEW.household_id;
END;
--> statement-breakpoint
--> statement-breakpoint
CREATE TRIGGER preserve_approved_lineage AFTER INSERT ON transactions
WHEN EXISTS (SELECT 1 FROM queue_items WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id)
BEGIN
  UPDATE transactions SET
    last_edited_at = (SELECT last_edited_at FROM queue_items WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1),
    parent_expense_id = (SELECT parent_expense_id FROM queue_items WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1),
    edited_by_member_id = CASE WHEN (SELECT last_edited_at FROM queue_items WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1) IS NOT NULL
      THEN (SELECT edited_by_member_id FROM queue_items WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1) ELSE edited_by_member_id END,
    edited_by_name = CASE WHEN (SELECT last_edited_at FROM queue_items WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1) IS NOT NULL
      THEN (SELECT edited_by_name FROM queue_items WHERE household_id = NEW.household_id AND expense_id = NEW.expense_id LIMIT 1) ELSE edited_by_name END
    WHERE id = NEW.id AND household_id = NEW.household_id;
END;
--> statement-breakpoint
-- Old approval code cannot interpret the new captured child allocation/card context.
CREATE TRIGGER reject_legacy_child_approval BEFORE INSERT ON transactions
WHEN NEW.parent_expense_id IS NULL
  AND EXISTS (SELECT 1 FROM queue_items current WHERE current.household_id = NEW.household_id
    AND current.expense_id = NEW.expense_id AND current.has_been_approved = 1 AND current.parent_expense_id IS NOT NULL)
  AND EXISTS (SELECT 1 FROM expense_history context WHERE context.household_id = NEW.household_id
    AND context.expense_id = NEW.expense_id AND json_type(context.after_json, '$.approvalBaseline') = 'object')
  AND NOT EXISTS (SELECT 1 FROM expense_history baseline WHERE baseline.household_id = NEW.household_id
    AND baseline.expense_id = NEW.expense_id AND baseline.event_type = 'returned_to_pending')
BEGIN
  SELECT RAISE(ABORT, 'This separated expense requires the current application version.');
END;
--> statement-breakpoint
WITH edits AS (
  SELECT edit.* FROM expense_history edit
  WHERE edit.event_type IN ('edited', 'category_suggestion') AND edit.before_json IS NOT NULL
    AND EXISTS (SELECT 1 FROM expense_history baseline
      WHERE baseline.household_id = edit.household_id AND baseline.expense_id = edit.expense_id
        AND baseline.revision <= edit.revision
        AND (json_extract(baseline.after_json, '$.state') = 'approved'
          OR json_extract(baseline.before_json, '$.state') = 'approved'))
    AND EXISTS (SELECT 1 FROM json_each('["date","store","amountCents","category","payerId","cardId","cardNameSnapshot","splitType","splitRuleJson","splitSharesJson","isStarred","favoriteName","reviewNote","isDuplicate"]') field
      WHERE json_extract(edit.before_json, '$.' || field.value) IS NOT json_extract(edit.after_json, '$.' || field.value))
), lineage AS (
  SELECT child.household_id, child.expense_id, parent.expense_id AS parent_expense_id
  FROM expense_history child JOIN expense_history parent
    ON parent.household_id = child.household_id
    AND parent.target_row_id = json_extract(child.after_json, '$.id')
    AND parent.event_type = 'edited' AND parent.source_row_id IS NOT NULL
    AND parent.expense_id <> child.expense_id
  WHERE child.before_json IS NULL
)
UPDATE queue_items AS current SET
  has_been_approved = EXISTS (SELECT 1 FROM expense_history baseline
    WHERE baseline.household_id = current.household_id AND baseline.expense_id = current.expense_id
      AND (json_extract(baseline.after_json, '$.state') = 'approved' OR json_extract(baseline.before_json, '$.state') = 'approved')),
  last_edited_at = (SELECT timestamp FROM edits WHERE household_id = current.household_id AND expense_id = current.expense_id ORDER BY revision DESC LIMIT 1),
  edited_by_member_id = CASE WHEN EXISTS (SELECT 1 FROM edits WHERE household_id = current.household_id AND expense_id = current.expense_id)
    THEN (SELECT actor_member_id FROM edits WHERE household_id = current.household_id AND expense_id = current.expense_id ORDER BY revision DESC LIMIT 1) ELSE edited_by_member_id END,
  edited_by_name = CASE WHEN EXISTS (SELECT 1 FROM edits WHERE household_id = current.household_id AND expense_id = current.expense_id)
    THEN (SELECT actor_name FROM edits WHERE household_id = current.household_id AND expense_id = current.expense_id ORDER BY revision DESC LIMIT 1) ELSE edited_by_name END,
  parent_expense_id = (SELECT parent_expense_id FROM lineage WHERE household_id = current.household_id AND expense_id = current.expense_id LIMIT 1);

--> statement-breakpoint
-- Update the legacy row after its guarded edit, keeping event-insert change counts intact.
CREATE TRIGGER preserve_legacy_transactions_edit AFTER UPDATE ON transactions
WHEN NEW.last_edited_at IS OLD.last_edited_at AND NEW.updated_at IS NOT OLD.updated_at
  AND NEW.has_been_approved = 1
  AND EXISTS (SELECT 1 FROM expense_history edit
    WHERE edit.household_id = NEW.household_id AND edit.expense_id = NEW.expense_id
      AND edit.revision = NEW.revision AND edit.event_type IN ('edited', 'category_suggestion')
      AND edit.before_json IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each('["date","store","amountCents","category","payerId","cardId","cardNameSnapshot","splitType","splitRuleJson","splitSharesJson","isStarred","favoriteName","reviewNote","isDuplicate"]') field
        WHERE json_extract(edit.before_json, '$.' || field.value) IS NOT json_extract(edit.after_json, '$.' || field.value)))
BEGIN
  UPDATE transactions SET last_edited_at = NEW.updated_at WHERE id = NEW.id AND household_id = NEW.household_id;
END;

--> statement-breakpoint
-- Update the legacy row after its guarded edit, keeping event-insert change counts intact.
CREATE TRIGGER preserve_legacy_queue_items_edit AFTER UPDATE ON queue_items
WHEN NEW.last_edited_at IS OLD.last_edited_at AND NEW.updated_at IS NOT OLD.updated_at
  AND NEW.has_been_approved = 1
  AND EXISTS (SELECT 1 FROM expense_history edit
    WHERE edit.household_id = NEW.household_id AND edit.expense_id = NEW.expense_id
      AND edit.revision = NEW.revision AND edit.event_type IN ('edited', 'category_suggestion')
      AND edit.before_json IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each('["date","store","amountCents","category","payerId","cardId","cardNameSnapshot","splitType","splitRuleJson","splitSharesJson","isStarred","favoriteName","reviewNote","isDuplicate"]') field
        WHERE json_extract(edit.before_json, '$.' || field.value) IS NOT json_extract(edit.after_json, '$.' || field.value)))
BEGIN
  UPDATE queue_items SET last_edited_at = NEW.updated_at WHERE id = NEW.id AND household_id = NEW.household_id;
END;
