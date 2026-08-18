CREATE TABLE `aiops_alert_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`alert_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`,`alert_id`) REFERENCES `aiops_alerts`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_aev_type" CHECK("event_type" IN ('ingested','severity_escalated','resolved','suppressed','unsuppressed','expired','run_triggered','run_completed'))
);
--> statement-breakpoint
CREATE INDEX `idx_aev_alert` ON `aiops_alert_events` (`tenant_id`,`alert_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_aev_type` ON `aiops_alert_events` (`tenant_id`,`event_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `aiops_alert_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`webhook_token_hash` text NOT NULL,
	`severity_mapping_json` text DEFAULT '{}' NOT NULL,
	`stale_after_seconds` integer DEFAULT 86400 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ck_asrc_type" CHECK("type" IN ('alertmanager','generic'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_asrc_token` ON `aiops_alert_sources` (`webhook_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_asrc_tenant` ON `aiops_alert_sources` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_asrc_tenant_id` ON `aiops_alert_sources` (`tenant_id`,`id`);--> statement-breakpoint
CREATE TABLE `aiops_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`source_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'firing' NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`labels_json` text NOT NULL,
	`annotations_json` text DEFAULT '{}' NOT NULL,
	`starts_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`resolved_at` integer,
	`correlated_run_id` text,
	`correlation_id` text,
	`suppress_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`,`source_id`) REFERENCES `aiops_alert_sources`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_alerts_status" CHECK("status" IN ('firing','resolved','suppressed','expired')),
	CONSTRAINT "ck_alerts_severity" CHECK("severity" IN ('critical','high','medium','low','info'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_alerts_active_fingerprint` ON `aiops_alerts` (`tenant_id`,`fingerprint`) WHERE "status" IN ('firing','suppressed');--> statement-breakpoint
CREATE INDEX `idx_alerts_tenant_status` ON `aiops_alerts` (`tenant_id`,`status`,`severity`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_alerts_source` ON `aiops_alerts` (`tenant_id`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_alerts_tenant_id` ON `aiops_alerts` (`tenant_id`,`id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `source_alert_id` text;--> statement-breakpoint
CREATE INDEX `idx_runs_tenant_source_alert` ON `runs` (`tenant_id`,`source_alert_id`);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- FK=OFF trigger mirror (0002 D1 / 0006 sqlite precedent) + append-only
-- guards.
--
-- D1 FK enforcement is disputed (0002 precedent: same mirror, zero-regret);
-- main-node prod runs PRAGMA foreign_keys = OFF. Declarative semantics are
-- mirrored by hand:
--
--   child INSERT / UPDATE      existence check (RAISE ABORT)
--   parent DELETE              NO ACTION (alert history blocks the delete)
--   parent PK / tenant UPDATE  NO ACTION (RAISE ABORT while referenced)
--
-- Append-only guards on aiops_alert_events (p1-aiops-alerts-spec §11 I10):
-- UPDATE and DELETE abort unconditionally — a step beyond run_events, whose
-- append-only is a service-layer discipline. The FK=OFF vitest suite
-- validates trigger coverage.
-- ---------------------------------------------------------------------------

-- aiops_alerts → aiops_alert_sources (ON DELETE NO ACTION) ------------------
CREATE TRIGGER trg_fki_alerts_asrc
BEFORE INSERT ON aiops_alerts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK violation: aiops_alerts (tenant_id, source_id) not found in aiops_alert_sources')
  WHERE NOT EXISTS (
    SELECT 1 FROM aiops_alert_sources
    WHERE tenant_id = NEW.tenant_id AND id = NEW.source_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_alerts_asrc
BEFORE UPDATE OF tenant_id, source_id ON aiops_alerts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK violation: aiops_alerts (tenant_id, source_id) not found in aiops_alert_sources')
  WHERE NOT EXISTS (
    SELECT 1 FROM aiops_alert_sources
    WHERE tenant_id = NEW.tenant_id AND id = NEW.source_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fkd_asrc_alerts
BEFORE DELETE ON aiops_alert_sources
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: aiops_alert_sources referenced by aiops_alerts')
  WHERE EXISTS (
    SELECT 1 FROM aiops_alerts
    WHERE tenant_id = OLD.tenant_id AND source_id = OLD.id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_asrc_pk
BEFORE UPDATE OF id, tenant_id ON aiops_alert_sources
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: aiops_alert_sources referenced by aiops_alerts')
  WHERE EXISTS (
    SELECT 1 FROM aiops_alerts
    WHERE tenant_id = OLD.tenant_id AND source_id = OLD.id
  );
END;
--> statement-breakpoint

-- aiops_alert_events → aiops_alerts (ON DELETE NO ACTION) --------------------
CREATE TRIGGER trg_fki_aev_alert
BEFORE INSERT ON aiops_alert_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK violation: aiops_alert_events (tenant_id, alert_id) not found in aiops_alerts')
  WHERE NOT EXISTS (
    SELECT 1 FROM aiops_alerts
    WHERE tenant_id = NEW.tenant_id AND id = NEW.alert_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_aev_alert
BEFORE UPDATE OF tenant_id, alert_id ON aiops_alert_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK violation: aiops_alert_events (tenant_id, alert_id) not found in aiops_alerts')
  WHERE NOT EXISTS (
    SELECT 1 FROM aiops_alerts
    WHERE tenant_id = NEW.tenant_id AND id = NEW.alert_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fkd_alerts_aev
BEFORE DELETE ON aiops_alerts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: aiops_alerts referenced by aiops_alert_events')
  WHERE EXISTS (
    SELECT 1 FROM aiops_alert_events
    WHERE tenant_id = OLD.tenant_id AND alert_id = OLD.id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_alerts_pk
BEFORE UPDATE OF id, tenant_id ON aiops_alerts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: aiops_alerts referenced by aiops_alert_events')
  WHERE EXISTS (
    SELECT 1 FROM aiops_alert_events
    WHERE tenant_id = OLD.tenant_id AND alert_id = OLD.id
  );
END;
--> statement-breakpoint

-- aiops_alert_events append-only guards (spec §11 I10 — 超越 run_events) -----
CREATE TRIGGER trg_aev_no_update
BEFORE UPDATE ON aiops_alert_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: aiops_alert_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER trg_aev_no_delete
BEFORE DELETE ON aiops_alert_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: aiops_alert_events is append-only');
END;
