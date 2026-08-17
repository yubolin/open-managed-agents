CREATE TABLE `run_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`stage_order` integer NOT NULL,
	`approver_id` text NOT NULL,
	`decision` text NOT NULL,
	`comment` text,
	`plan_hash_at_decision` text NOT NULL,
	`evidence_snapshot_hash_at_decision` text NOT NULL,
	`is_invalidated` integer DEFAULT 0 NOT NULL,
	`invalidated_reason` text,
	`invalidated_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`,`run_id`) REFERENCES `runs`(`tenant_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_run_approvals_decision" CHECK("decision" IN ('approved','rejected','changes_requested'))
);
--> statement-breakpoint
CREATE INDEX `idx_run_approvals_run` ON `run_approvals` (`tenant_id`,`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_run_approvals_approver` ON `run_approvals` (`tenant_id`,`approver_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `run_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`type` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`content_sha256` text NOT NULL,
	`metadata` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`,`run_id`) REFERENCES `runs`(`tenant_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_run_artifacts_type" CHECK("type" IN ('plan','diagnosis_evidence','execution_log'))
);
--> statement-breakpoint
CREATE INDEX `idx_run_artifacts_run` ON `run_artifacts` (`tenant_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_run_artifacts_hash` ON `run_artifacts` (`content_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_run_artifacts_run_type_version` ON `run_artifacts` (`tenant_id`,`run_id`,`type`,`version`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_version` text,
	`run_id` text,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`phase` text NOT NULL,
	`result` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`payload` text,
	`duration_ms` integer,
	`trace_id` text NOT NULL,
	`ts` integer NOT NULL,
	FOREIGN KEY (`tenant_id`,`run_id`) REFERENCES `runs`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_run_events_resource_type" CHECK("resource_type" IN ('run','template','approval')),
	CONSTRAINT "ck_run_events_phase" CHECK("phase" IN ('intent','result','reconciliation')),
	CONSTRAINT "ck_run_events_result" CHECK("result" IN ('pending','success','failure','uncertain'))
);
--> statement-breakpoint
CREATE INDEX `idx_run_events_tenant_run` ON `run_events` (`tenant_id`,`run_id`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_run_events_resource` ON `run_events` (`tenant_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `idx_run_events_action` ON `run_events` (`tenant_id`,`action`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_run_events_trace` ON `run_events` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_run_events_ts` ON `run_events` (`tenant_id`,`ts`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`title` text NOT NULL,
	`created_by` text NOT NULL,
	`service_template_id` text NOT NULL,
	`template_version_id` text NOT NULL,
	`knowledge_refs` text,
	`input_parameters` text NOT NULL,
	`state` text NOT NULL,
	`current_approval_stage` integer DEFAULT 1 NOT NULL,
	`session_id` text,
	`snapshot_hash` text,
	`plan_hash` text,
	`evidence_snapshot_id` text,
	`evidence_snapshot_hash` text,
	`active_approval_id` text,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`submitted_at` integer,
	`planned_at` integer,
	`approved_at` integer,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT "ck_runs_state" CHECK("state" IN ('draft','submitted','planning','awaiting_approval','approved','rejected','changes_requested','executing','succeeded','failed','interrupted','cancelled','approval_invalidated'))
);
--> statement-breakpoint
CREATE INDEX `idx_runs_tenant_state` ON `runs` (`tenant_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_tenant_creator` ON `runs` (`tenant_id`,`created_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_session` ON `runs` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_runs_tenant_id` ON `runs` (`tenant_id`,`id`);--> statement-breakpoint
CREATE TABLE `service_template_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`version` integer NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`agent_binding` text NOT NULL,
	`form_schema` text NOT NULL,
	`ui_schema` text,
	`approval_policy` text NOT NULL,
	`timeout_policy` text NOT NULL,
	`changelog` text,
	`published_by` text NOT NULL,
	`published_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`,`template_id`) REFERENCES `service_templates`(`tenant_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_template_versions_template` ON `service_template_versions` (`tenant_id`,`template_id`,`published_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_template_versions_template_version` ON `service_template_versions` (`template_id`,`version`);--> statement-breakpoint
CREATE TABLE `service_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`category` text NOT NULL,
	`description` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`current_version_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ck_service_templates_category" CHECK("category" IN ('diagnostic','change_plan'))
);
--> statement-breakpoint
CREATE INDEX `idx_service_templates_tenant` ON `service_templates` (`tenant_id`,`is_active`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_service_templates_tenant_code` ON `service_templates` (`tenant_id`,`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_service_templates_tenant_id` ON `service_templates` (`tenant_id`,`id`);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- FK=OFF trigger mirror (feishu-ops 0002 precedent).
--
-- main-node prod runs PRAGMA foreign_keys = OFF (apps/main-node/src/index.ts),
-- which renders every FOREIGN KEY clause above inert. These triggers mirror
-- the declarative semantics by hand:
--
--   child INSERT / UPDATE      existence check (RAISE ABORT)
--   parent DELETE              CASCADE (versions / approvals / artifacts) or
--                              NO ACTION (run_events — audit blocks the delete)
--   parent PK / tenant UPDATE  NO ACTION (RAISE ABORT while referenced)
--
-- run_events is MATCH SIMPLE: run_id IS NULL (template-level events) skips
-- the existence check entirely. The FK=OFF vitest suite
-- (test/operations-tables.schema.test.ts) validates the trigger coverage.
-- ---------------------------------------------------------------------------

-- service_template_versions → service_templates (ON DELETE CASCADE) --------
CREATE TRIGGER trg_fki_stv_template
BEFORE INSERT ON service_template_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK violation: service_template_versions (tenant_id, template_id) not found in service_templates')
  WHERE NOT EXISTS (
    SELECT 1 FROM service_templates
    WHERE tenant_id = NEW.tenant_id AND id = NEW.template_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_stv_template
BEFORE UPDATE OF tenant_id, template_id ON service_template_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK violation: service_template_versions (tenant_id, template_id) not found in service_templates')
  WHERE NOT EXISTS (
    SELECT 1 FROM service_templates
    WHERE tenant_id = NEW.tenant_id AND id = NEW.template_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fkd_service_templates_stv
AFTER DELETE ON service_templates
FOR EACH ROW
BEGIN
  DELETE FROM service_template_versions
  WHERE tenant_id = OLD.tenant_id AND template_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_service_templates_pk
BEFORE UPDATE OF id, tenant_id ON service_templates
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: service_templates referenced by service_template_versions')
  WHERE EXISTS (
    SELECT 1 FROM service_template_versions
    WHERE tenant_id = OLD.tenant_id AND template_id = OLD.id
  );
END;
--> statement-breakpoint

-- run_approvals → runs (ON DELETE CASCADE) ----------------------------------
CREATE TRIGGER trg_fki_ra_run
BEFORE INSERT ON run_approvals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK violation: run_approvals (tenant_id, run_id) not found in runs')
  WHERE NOT EXISTS (
    SELECT 1 FROM runs
    WHERE tenant_id = NEW.tenant_id AND id = NEW.run_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_ra_run
BEFORE UPDATE OF tenant_id, run_id ON run_approvals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK violation: run_approvals (tenant_id, run_id) not found in runs')
  WHERE NOT EXISTS (
    SELECT 1 FROM runs
    WHERE tenant_id = NEW.tenant_id AND id = NEW.run_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fkd_runs_ra
AFTER DELETE ON runs
FOR EACH ROW
BEGIN
  DELETE FROM run_approvals
  WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id;
END;
--> statement-breakpoint

-- run_artifacts → runs (ON DELETE CASCADE) ----------------------------------
CREATE TRIGGER trg_fki_rart_run
BEFORE INSERT ON run_artifacts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK violation: run_artifacts (tenant_id, run_id) not found in runs')
  WHERE NOT EXISTS (
    SELECT 1 FROM runs
    WHERE tenant_id = NEW.tenant_id AND id = NEW.run_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_rart_run
BEFORE UPDATE OF tenant_id, run_id ON run_artifacts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FK violation: run_artifacts (tenant_id, run_id) not found in runs')
  WHERE NOT EXISTS (
    SELECT 1 FROM runs
    WHERE tenant_id = NEW.tenant_id AND id = NEW.run_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fkd_runs_rart
AFTER DELETE ON runs
FOR EACH ROW
BEGIN
  DELETE FROM run_artifacts
  WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id;
END;
--> statement-breakpoint

-- run_events → runs (MATCH SIMPLE, ON DELETE NO ACTION) --------------------
CREATE TRIGGER trg_fki_re_run
BEFORE INSERT ON run_events
FOR EACH ROW
WHEN NEW.run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'FK violation: run_events (tenant_id, run_id) not found in runs')
  WHERE NOT EXISTS (
    SELECT 1 FROM runs
    WHERE tenant_id = NEW.tenant_id AND id = NEW.run_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fku_re_run
BEFORE UPDATE OF tenant_id, run_id ON run_events
FOR EACH ROW
WHEN NEW.run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'FK violation: run_events (tenant_id, run_id) not found in runs')
  WHERE NOT EXISTS (
    SELECT 1 FROM runs
    WHERE tenant_id = NEW.tenant_id AND id = NEW.run_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER trg_fkd_runs_re
BEFORE DELETE ON runs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: runs referenced by run_events')
  WHERE EXISTS (
    SELECT 1 FROM run_events
    WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id
  );
END;
--> statement-breakpoint

-- runs PK / tenant identity UPDATE recheck (NO ACTION across all children) -
CREATE TRIGGER trg_fku_runs_pk
BEFORE UPDATE OF id, tenant_id ON runs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'NO ACTION: runs referenced by child rows')
  WHERE EXISTS (SELECT 1 FROM run_approvals WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id)
     OR EXISTS (SELECT 1 FROM run_artifacts WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id)
     OR EXISTS (SELECT 1 FROM run_events WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id);
END;