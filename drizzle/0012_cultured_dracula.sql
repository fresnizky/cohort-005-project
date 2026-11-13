CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipient_user_id` integer NOT NULL,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`sentence` text NOT NULL,
	`excerpt` text,
	`link` text NOT NULL,
	`created_at` text NOT NULL,
	`seen_at` text,
	`read_at` text,
	`archived_at` text,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_seen_idx` ON `notifications` (`recipient_user_id`,`seen_at`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_list_idx` ON `notifications` (`recipient_user_id`,`archived_at`,`read_at`,`created_at`);