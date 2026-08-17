// Operations Workspace Domain Types (Spec v0.4.3 & PRD v0.5).

export type RunState =
  | "draft"
  | "submitted"
  | "planning"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "executing"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "approval_invalidated";

export type ApprovalDecision = "approved" | "rejected" | "changes_requested";

export type ArtifactType = "plan" | "diagnosis_evidence" | "execution_log";

export type TemplateCategory = "diagnostic" | "change_plan";

export type AuditEventPhase = "intent" | "result" | "reconciliation";

export type AuditEventResult = "pending" | "success" | "failure" | "uncertain";

export type AuditResourceType = "run" | "template" | "approval";

export interface AuditActor {
  type: "user" | "agent" | "system";
  id: string;
  name?: string;
  role?: string;
}

export interface ApprovalStageConfig {
  stage_order: number;
  stage_name: string;
  group_id: string;
  required_approvals: number;
}

export interface ApprovalPolicy {
  mode: "sequential_groups";
  stages: ApprovalStageConfig[];
  fallback_to_default_group?: boolean;
  default_group_id?: string;
}

export interface TimeoutEscalationAction {
  at_minute: number;
  action: "notify_feishu_group" | "notify_process_owner" | "mark_approval_overdue_and_cancel";
  target?: string;
  channel?: string;
  final_state_behavior?: "cancelled";
}

export interface TimeoutPolicy {
  approval_timeout_minutes: number;
  escalation_interval_minutes: number;
  escalation_actions: TimeoutEscalationAction[];
}

export interface AgentBinding {
  agent_id: string;
  version: number;
}

// ----------------------------------------------------------------------------
// Database Row Representations
// ----------------------------------------------------------------------------

export interface ServiceTemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  code: string;
  category: TemplateCategory;
  description: string | null;
  is_active: number;
  current_version_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface ServiceTemplateVersionRow {
  id: string;
  template_id: string;
  tenant_id: string;
  version: number;
  is_active: number;
  agent_binding: string; // JSON
  form_schema: string; // JSON
  ui_schema: string | null; // JSON
  approval_policy: string; // JSON
  timeout_policy: string; // JSON
  changelog: string | null;
  published_by: string;
  published_at: number;
}

export interface RunRow {
  id: string;
  tenant_id: string;
  title: string;
  created_by: string;
  service_template_id: string;
  template_version_id: string;
  knowledge_refs: string | null; // JSON
  input_parameters: string; // JSON
  state: RunState;
  current_approval_stage: number;
  session_id: string | null;
  snapshot_hash: string | null;
  plan_hash: string | null;
  evidence_snapshot_id: string | null;
  evidence_snapshot_hash: string | null;
  active_approval_id: string | null;
  failure_reason: string | null; // JSON
  created_at: number;
  updated_at: number;
  submitted_at: number | null;
  planned_at: number | null;
  approved_at: number | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface RunApprovalRow {
  id: string;
  run_id: string;
  tenant_id: string;
  stage_order: number;
  approver_id: string;
  decision: ApprovalDecision;
  comment: string | null;
  plan_hash_at_decision: string;
  evidence_snapshot_hash_at_decision: string;
  is_invalidated: number;
  invalidated_reason: string | null;
  invalidated_at: number | null;
  created_at: number;
}

export interface RunArtifactRow {
  id: string;
  run_id: string;
  tenant_id: string;
  type: ArtifactType;
  version: number;
  content: string;
  content_sha256: string;
  metadata: string | null; // JSON
  created_by: string;
  created_at: number;
}

export interface RunEventRow {
  id: string;
  tenant_id: string;
  resource_type: AuditResourceType;
  resource_id: string;
  resource_version: string | null;
  run_id: string | null;
  actor: string; // JSON
  action: string;
  phase: AuditEventPhase;
  result: AuditEventResult;
  from_state: string | null;
  to_state: string | null;
  payload: string | null; // JSON
  duration_ms: number | null;
  trace_id: string;
  ts: number;
}

// ----------------------------------------------------------------------------
// Domain DTOs
// ----------------------------------------------------------------------------

export interface CreateRunParams {
  tenantId: string;
  templateId: string;
  templateVersionId?: string;
  title: string;
  inputParameters: Record<string, unknown>;
  actor: AuditActor;
  knowledgeRefs?: Record<string, unknown>;
  autoSubmit?: boolean;
}

export interface DecideApprovalParams {
  tenantId: string;
  runId: string;
  actor: AuditActor;
  decision: ApprovalDecision;
  comment?: string;
  traceId?: string;
}

export interface ReworkRunParams {
  tenantId: string;
  runId: string;
  actor: AuditActor;
  inputParameters?: Record<string, unknown>;
  comment?: string;
  traceId?: string;
}

export interface CancelRunParams {
  tenantId: string;
  runId: string;
  actor: AuditActor;
  reason?: string;
  traceId?: string;
}

export interface RecordArtifactParams {
  tenantId: string;
  runId: string;
  type: ArtifactType;
  content: string;
  contentSha256: string;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEventParams {
  tenantId: string;
  resourceType: AuditResourceType;
  resourceId: string;
  resourceVersion?: string;
  runId?: string;
  actor: AuditActor;
  action: string;
  phase: AuditEventPhase;
  result: AuditEventResult;
  fromState?: string;
  toState?: string;
  payload?: Record<string, unknown>;
  durationMs?: number;
  traceId?: string;
}
