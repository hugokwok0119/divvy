CREATE TABLE `ai_usage` (
	`household_id` text NOT NULL,
	`usage_date` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`household_id`, `usage_date`)
);
--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`member_id` text NOT NULL,
	`name` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `category_preferences` (
	`household_id` text NOT NULL,
	`store_key` text NOT NULL,
	`category` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`household_id`, `store_key`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`status` text DEFAULT 'closed' NOT NULL,
	`settlement_json` text,
	`closed_at` integer NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `household_members` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_members_user_id_unique` ON `household_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`currency_code` text DEFAULT 'CAD' NOT NULL,
	`timezone` text DEFAULT 'America/Vancouver' NOT NULL,
	`custom_categories_json` text DEFAULT '[]' NOT NULL,
	`allowed_emails_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`date` text,
	`store` text,
	`amount_cents` integer,
	`category` text,
	`payer_id` text,
	`card_id` text,
	`split_type` text,
	`is_duplicate` integer DEFAULT 0 NOT NULL,
	`source` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`cycle_id` text,
	`date` text NOT NULL,
	`store` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`category` text NOT NULL,
	`payer_id` text NOT NULL,
	`card_id` text,
	`card_name_snapshot` text,
	`split_type` text NOT NULL,
	`split_rule_json` text,
	`split_shares_json` text NOT NULL,
	`is_starred` integer DEFAULT 0 NOT NULL,
	`favorite_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cycle_id`) REFERENCES `cycles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payer_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tx_scope_idx` ON `transactions` (`household_id`,`cycle_id`,`date`);