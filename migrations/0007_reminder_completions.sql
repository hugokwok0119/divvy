CREATE TABLE `reminder_completions` (
	`household_id` text NOT NULL,
	`month` text NOT NULL,
	`reminder_id` text NOT NULL,
	`completed_by_member_id` text,
	`completed_at` integer NOT NULL,
	PRIMARY KEY(`household_id`, `month`, `reminder_id`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
