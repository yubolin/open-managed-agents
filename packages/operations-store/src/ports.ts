// Abstract storage port for Operations Workspace domain.

import type {
  RunApprovalRow,
  RunArtifactRow,
  RunEventRow,
  RunRow,
  RunState,
  ServiceTemplateRow,
  ServiceTemplateVersionRow,
} from "./types";

export interface ListRunsOptions {
  state?: RunState;
  createdBy?: string;
  serviceTemplateId?: string;
  limit?: number;
  offset?: number;
}

export interface OperationsStorePort {
  // Service Templates
  getTemplate(tenantId: string, templateId: string): Promise<ServiceTemplateRow | null>;
  getTemplateByCode(tenantId: string, code: string): Promise<ServiceTemplateRow | null>;
  listTemplates(tenantId: string, category?: string, onlyActive?: boolean): Promise<ServiceTemplateRow[]>;
  getTemplateVersion(tenantId: string, versionId: string): Promise<ServiceTemplateVersionRow | null>;
  getLatestTemplateVersion(tenantId: string, templateId: string): Promise<ServiceTemplateVersionRow | null>;
  insertTemplate(template: ServiceTemplateRow, initialVersion: ServiceTemplateVersionRow): Promise<void>;
  insertTemplateVersion(version: ServiceTemplateVersionRow): Promise<void>;
  setTemplateVersionActive(tenantId: string, versionId: string, isActive: boolean): Promise<void>;

  // Runs & CAS State Transitions
  getRun(tenantId: string, runId: string): Promise<RunRow | null>;
  listRuns(tenantId: string, options?: ListRunsOptions): Promise<RunRow[]>;
  /**
   * SYSTEM-LEVEL scan across ALL tenants for runs parked in awaiting_approval.
   * Sole consumer: the approval-timeout scheduler (a system component, not a
   * user request path). NEVER expose through the BFF — user-facing queries
   * must stay tenant-prefixed (D0 §6.1).
   */
  listAwaitingApprovalRunsSystem(limit: number): Promise<RunRow[]>;
  insertRun(run: RunRow): Promise<void>;
  /**
   * Atomic CAS update: updates run fields ONLY IF current state === fromState.
   * Returns true if 1 row was updated, false if 0 rows (state conflict).
   */
  updateRunCAS(
    tenantId: string,
    runId: string,
    fromState: RunState,
    updates: Partial<RunRow>
  ): Promise<boolean>;

  // Approvals
  insertApproval(approval: RunApprovalRow): Promise<void>;
  listApprovals(tenantId: string, runId: string): Promise<RunApprovalRow[]>;
  getActiveApproval(tenantId: string, runId: string): Promise<RunApprovalRow | null>;
  invalidateApprovals(tenantId: string, runId: string, reason: string, now: number): Promise<void>;

  // Artifacts (Append-Only)
  insertArtifact(artifact: RunArtifactRow): Promise<void>;
  listArtifacts(tenantId: string, runId: string, type?: string): Promise<RunArtifactRow[]>;
  getLatestArtifact(tenantId: string, runId: string, type: string): Promise<RunArtifactRow | null>;

  // D0 Audit Events (Append-Only)
  insertEvent(event: RunEventRow): Promise<void>;
  listEvents(tenantId: string, runId?: string, limit?: number): Promise<RunEventRow[]>;

  // Transaction boundary
  transaction<T>(fn: (tx: OperationsStorePort) => Promise<T>): Promise<T>;
}
