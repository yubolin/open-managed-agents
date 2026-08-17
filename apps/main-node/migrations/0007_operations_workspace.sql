CREATE TABLE "run_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"stage_order" bigint NOT NULL,
	"approver_id" text NOT NULL,
	"decision" text NOT NULL,
	"comment" text,
	"plan_hash_at_decision" text NOT NULL,
	"evidence_snapshot_hash_at_decision" text NOT NULL,
	"is_invalidated" bigint DEFAULT 0 NOT NULL,
	"invalidated_reason" text,
	"invalidated_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "ck_run_approvals_decision" CHECK ("decision" IN ('approved','rejected','changes_requested'))
);
--> statement-breakpoint
CREATE TABLE "run_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"type" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"content" text NOT NULL,
	"content_sha256" text NOT NULL,
	"metadata" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "uq_run_artifacts_run_type_version" UNIQUE("tenant_id","run_id","type","version"),
	CONSTRAINT "ck_run_artifacts_type" CHECK ("type" IN ('plan','diagnosis_evidence','execution_log'))
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_version" text,
	"run_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"phase" text NOT NULL,
	"result" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"payload" text,
	"duration_ms" bigint,
	"trace_id" text NOT NULL,
	"ts" bigint NOT NULL,
	CONSTRAINT "ck_run_events_resource_type" CHECK ("resource_type" IN ('run','template','approval')),
	CONSTRAINT "ck_run_events_phase" CHECK ("phase" IN ('intent','result','reconciliation')),
	CONSTRAINT "ck_run_events_result" CHECK ("result" IN ('pending','success','failure','uncertain'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"created_by" text NOT NULL,
	"service_template_id" text NOT NULL,
	"template_version_id" text NOT NULL,
	"knowledge_refs" text,
	"input_parameters" text NOT NULL,
	"state" text NOT NULL,
	"current_approval_stage" bigint DEFAULT 1 NOT NULL,
	"session_id" text,
	"snapshot_hash" text,
	"plan_hash" text,
	"evidence_snapshot_id" text,
	"evidence_snapshot_hash" text,
	"active_approval_id" text,
	"failure_reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"submitted_at" bigint,
	"planned_at" bigint,
	"approved_at" bigint,
	"started_at" bigint,
	"finished_at" bigint,
	CONSTRAINT "uq_runs_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ck_runs_state" CHECK ("state" IN ('draft','submitted','planning','awaiting_approval','approved','rejected','changes_requested','executing','succeeded','failed','interrupted','cancelled','approval_invalidated'))
);
--> statement-breakpoint
CREATE TABLE "service_template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"version" bigint NOT NULL,
	"is_active" bigint DEFAULT 1 NOT NULL,
	"agent_binding" text NOT NULL,
	"form_schema" text NOT NULL,
	"ui_schema" text,
	"approval_policy" text NOT NULL,
	"timeout_policy" text NOT NULL,
	"changelog" text,
	"published_by" text NOT NULL,
	"published_at" bigint NOT NULL,
	CONSTRAINT "uq_template_versions_template_version" UNIQUE("template_id","version")
);
--> statement-breakpoint
CREATE TABLE "service_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"is_active" bigint DEFAULT 1 NOT NULL,
	"current_version_id" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "uq_service_templates_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "uq_service_templates_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ck_service_templates_category" CHECK ("category" IN ('diagnostic','change_plan'))
);
--> statement-breakpoint
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_tenant_id_run_id_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_tenant_id_run_id_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_tenant_id_run_id_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_template_versions" ADD CONSTRAINT "service_template_versions_tenant_id_template_id_service_templates_tenant_id_id_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."service_templates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_approvals_run" ON "run_approvals" USING btree ("tenant_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_run_approvals_approver" ON "run_approvals" USING btree ("tenant_id","approver_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_run_artifacts_run" ON "run_artifacts" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_run_artifacts_hash" ON "run_artifacts" USING btree ("content_sha256");--> statement-breakpoint
CREATE INDEX "idx_run_events_tenant_run" ON "run_events" USING btree ("tenant_id","run_id","ts");--> statement-breakpoint
CREATE INDEX "idx_run_events_resource" ON "run_events" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "idx_run_events_action" ON "run_events" USING btree ("tenant_id","action","ts");--> statement-breakpoint
CREATE INDEX "idx_run_events_trace" ON "run_events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "idx_run_events_ts" ON "run_events" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "idx_runs_tenant_state" ON "runs" USING btree ("tenant_id","state","created_at");--> statement-breakpoint
CREATE INDEX "idx_runs_tenant_creator" ON "runs" USING btree ("tenant_id","created_by","created_at");--> statement-breakpoint
CREATE INDEX "idx_runs_session" ON "runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_template_versions_template" ON "service_template_versions" USING btree ("tenant_id","template_id","published_at");--> statement-breakpoint
CREATE INDEX "idx_service_templates_tenant" ON "service_templates" USING btree ("tenant_id","is_active");