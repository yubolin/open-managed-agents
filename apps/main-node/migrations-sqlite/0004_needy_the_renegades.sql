-- aiops_alerts table (AIOps Phase 1).
--
-- NOTE: drizzle-kit generated this file against the 0002 snapshot (0003's
-- snapshot was never committed), so its original body also re-created the
-- six feishu tables that 0003_feishu_publication_first.sql already makes —
-- applying it would fail with "table feishu_apps already exists". The
-- feishu section was stripped; meta/0004_snapshot.json is kept as
-- generated (feishu + aiops) so it restores snapshot/DB parity and the
-- next drizzle-kit generate diffs correctly.
CREATE TABLE `aiops_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`source` text NOT NULL,
	`fingerprint` text NOT NULL,
	`severity` text NOT NULL,
	`name` text NOT NULL,
	`labels` text DEFAULT '{}' NOT NULL,
	`annotations` text DEFAULT '{}' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`dedup_count` integer DEFAULT 1 NOT NULL,
	`last_seen_at` integer NOT NULL,
	`session_id` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "ck_aiops_alerts_status" CHECK("status" IN ('new','dispatching','dispatched','error','deduped','resolved')),
	CONSTRAINT "ck_aiops_alerts_severity" CHECK("severity" IN ('critical','warning','info'))
);
--> statement-breakpoint
CREATE INDEX `idx_aiops_alerts_fingerprint` ON `aiops_alerts` (`tenant_id`,`fingerprint`,`status`);--> statement-breakpoint
CREATE INDEX `idx_aiops_alerts_status_created` ON `aiops_alerts` (`status`,`created_at`);
