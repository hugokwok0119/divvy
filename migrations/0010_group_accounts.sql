CREATE TABLE `member_accounts` (
	`member_id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`linked_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_accounts_group_user_idx` ON `member_accounts` (`household_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `member_accounts_user_idx` ON `member_accounts` (`user_id`);--> statement-breakpoint
ALTER TABLE `household_members` ADD `sitting_out_at` integer;--> statement-breakpoint
CREATE INDEX `members_household_idx` ON `household_members` (`household_id`);--> statement-breakpoint
ALTER TABLE `households` ADD `rent_reminder` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `cards_household_idx` ON `cards` (`household_id`);--> statement-breakpoint
CREATE INDEX `cycles_household_idx` ON `cycles` (`household_id`);--> statement-breakpoint
CREATE INDEX `queue_household_idx` ON `queue_items` (`household_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO member_accounts (member_id, household_id, user_id, linked_at)
SELECT id, household_id, user_id, created_at FROM household_members WHERE user_id IS NOT NULL;
--> statement-breakpoint
-- Keep member_accounts in step with code that still writes household_members.user_id; drop these with that column.
CREATE TRIGGER mirror_member_account_insert AFTER INSERT ON household_members
WHEN NEW.user_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO member_accounts (member_id, household_id, user_id, linked_at)
  VALUES (NEW.id, NEW.household_id, NEW.user_id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER mirror_member_account_update AFTER UPDATE OF user_id ON household_members
WHEN NEW.user_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO member_accounts (member_id, household_id, user_id, linked_at)
  VALUES (NEW.id, NEW.household_id, NEW.user_id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
