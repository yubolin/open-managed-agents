// CmpConnector port — the four CMP service surfaces (requirement 2:
// Automation / ITSM / CMDB / 运营数据服务协同). Requests are zod-parsed at
// the adapter boundary so a malformed call fails fast with a readable error
// instead of drifting into the fake/real adapter difference.

import { z } from "zod";
import type {
  CmdbEntity,
  CmdbRelationship,
  CmpExecution,
  CmpRunbook,
  ItsmTicket,
  OpsEventRecord,
  OpsLogLine,
  OpsMetricPoint,
} from "./domain.js";

// ── Request schemas ──────────────────────────────────────────────────────

export const cmdbEntityQuerySchema = z
  .object({
    entity_id: z.string().optional(),
    hostname: z.string().optional(),
    ip: z.string().optional(),
  })
  .refine((q) => !!(q.entity_id || q.hostname || q.ip), {
    message: "one of entity_id / hostname / ip is required",
  });
export type CmdbEntityQuery = z.infer<typeof cmdbEntityQuerySchema>;

export const itsmCreateTicketSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(["critical", "warning", "info"]),
  source_alert_id: z.string().optional(),
});
export type ItsmCreateTicketInput = z.infer<typeof itsmCreateTicketSchema>;

export const automationExecuteSchema = z.object({
  runbook_id: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  /** Approval-gate traceability: the approved approval_requests row id. */
  approval_id: z.string().min(1),
});
export type AutomationExecuteInput = z.infer<typeof automationExecuteSchema>;

export const opsRangeSchema = z.object({
  from_ms: z.number().int().nonnegative(),
  to_ms: z.number().int().nonnegative(),
});
export type OpsRange = z.infer<typeof opsRangeSchema>;

// ── Port ─────────────────────────────────────────────────────────────────

export interface CmpCmdbSurface {
  /** Locate one entity by id / hostname / ip. Null when unknown. */
  getEntity(query: CmdbEntityQuery): Promise<CmdbEntity | null>;
  /** Topology edges touching an entity (both directions). */
  getRelationships(entityId: string): Promise<CmdbRelationship[]>;
}

export interface CmpItsmSurface {
  createTicket(input: ItsmCreateTicketInput): Promise<ItsmTicket>;
  /** Append an analysis/execution note. Idempotent per content. */
  appendNote(
    ticketId: string,
    note: string,
  ): Promise<{ ok: boolean; error?: string }>;
  updateStatus(
    ticketId: string,
    status: ItsmTicket["status"],
  ): Promise<{ ok: boolean; error?: string }>;
  getTicket(ticketId: string): Promise<ItsmTicket | null>;
}

export interface CmpAutomationSurface {
  listRunbooks(): Promise<CmpRunbook[]>;
  /** Preview what execute would do without side effects. */
  dryRun(
    runbookId: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; plan: string; error?: string }>;
  /** Execute a runbook. The approval_id is carried for CMP-side audit. */
  execute(input: AutomationExecuteInput): Promise<CmpExecution>;
  getExecution(executionId: string): Promise<CmpExecution | null>;
}

export interface CmpOpsDataSurface {
  queryMetrics(q: {
    entity_id: string;
    metric: string;
    range: OpsRange;
  }): Promise<OpsMetricPoint[]>;
  queryLogs(q: {
    entity_id: string;
    keywords?: string[];
    range: OpsRange;
  }): Promise<OpsLogLine[]>;
  queryEvents(q: {
    entity_id: string;
    range: OpsRange;
  }): Promise<OpsEventRecord[]>;
}

export interface CmpConnector {
  cmdb: CmpCmdbSurface;
  itsm: CmpItsmSurface;
  automation: CmpAutomationSurface;
  opsdata: CmpOpsDataSurface;
}
