// CMP domain types — the enterprise Cloud Management Platform surface the
// AIOps digital employees operate against: CMDB, ITSM, Automation, and
// operations data services (docs/aiops-closed-loop.md requirement 2).
//
// Contract-first: `CmpConnector` (./port.ts) is the only thing agent tools
// and the approval flow depend on. The in-memory fake (./test-fakes.ts)
// serves dev + tests; the real HTTP adapter lands when the CMP API spec
// arrives and is swapped in at the composition root with zero tool changes.

export type CmdbEntityClass =
  | "host"
  | "vm"
  | "container"
  | "database"
  | "middleware"
  | "network"
  | "k8s"
  | "service";

export interface CmdbEntity {
  id: string;
  entity_class: CmdbEntityClass;
  hostname: string;
  ip: string | null;
  region: string | null;
  labels: Record<string, string>;
  owner_team: string | null;
}

export type CmdbRelationshipType =
  | "runs_on"
  | "depends_on"
  | "connects_to"
  | "part_of";

export interface CmdbRelationship {
  source_id: string;
  target_id: string;
  type: CmdbRelationshipType;
}

export type ItsmTicketStatus =
  | "open"
  | "in_progress"
  | "pending"
  | "resolved"
  | "closed";

export interface ItsmTicket {
  ticket_id: string;
  title: string;
  status: ItsmTicketStatus;
  url: string | null;
  created_at: number;
}

export type CmpRunbookRisk = "low" | "medium" | "high";

export interface CmpRunbook {
  id: string;
  name: string;
  description: string;
  risk_level: CmpRunbookRisk;
  /** JSON-Schema-ish parameter description, mirroring custom tool shapes. */
  params_schema: Record<string, unknown>;
}

export type CmpExecutionStatus = "queued" | "running" | "succeeded" | "failed";

export interface CmpExecution {
  execution_id: string;
  runbook_id: string;
  status: CmpExecutionStatus;
  output: string | null;
  started_at: number;
}

export interface OpsMetricPoint {
  ts: number;
  value: number;
}

export interface OpsLogLine {
  ts: number;
  severity: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface OpsEventRecord {
  ts: number;
  kind: string;
  message: string;
}

export type CmpAlertSeverity = "critical" | "warning" | "info";
