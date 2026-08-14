// ApprovalStore — persisted approval gate for CMP automation actions
// (docs/aiops-closed-loop.md requirement 5: 分析 → 建议 → 审批 → 执行 → 回写).
//
// Security model:
//   - Agents CREATE requests (requested_by = "agent:<id>"); they can never
//     decide. The decide endpoint is human-only (user-scoped principal),
//     enforced at the route layer in aiops-subsystem.ts.
//   - The execute gate (cmp-agent-tools.ts) re-verifies status/session/
//     runbook server-side on every call — an approved record for a
//     different session or runbook does not unlock anything.
//   - expires_at + expireStale() guarantee a never-decided request can't
//     be approved after the fact.
//
// Enterprise-isolation: main-node-local (like the memory-freeze gate), no
// upstream package depends on it. Table: approval_requests (0006 sqlite /
// 0007 pg), journal-only migrations.

import { randomBytes } from "node:crypto";
import type { SqlClient } from "@open-managed-agents/sql-client";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/** The gated action. Kind-discriminated so future gates (read-only CMP
 *  queries never need approval; only state-changing automation does). */
export interface ApprovalAction {
  kind: "automation_execute";
  runbook_id: string;
  params: Record<string, unknown>;
  /** Human-readable summary shown in the approval queue. */
  summary: string;
}

export interface ApprovalRequest {
  id: string;
  tenantId: string;
  sessionId: string;
  alertId: string | null;
  action: ApprovalAction;
  status: ApprovalStatus;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: number | null;
  expiresAt: number;
  reason: string | null;
  createdAt: number;
}

interface ApprovalRow {
  id: string;
  tenant_id: string;
  session_id: string;
  alert_id: string | null;
  action: string;
  status: string;
  requested_by: string;
  decided_by: string | null;
  decided_at: number | string | null;
  expires_at: number | string;
  reason: string | null;
  created_at: number | string;
}

const APPROVAL_COLS = `id, tenant_id, session_id, alert_id, action, status,
  requested_by, decided_by, decided_at, expires_at, reason, created_at`;

function num(v: number | string | null): number | null {
  if (v === null) return null;
  return typeof v === "number" ? v : Number(v);
}

function rowToApproval(row: ApprovalRow): ApprovalRequest | null {
  let action: ApprovalAction;
  try {
    action = JSON.parse(row.action) as ApprovalAction;
  } catch {
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    alertId: row.alert_id,
    action,
    status: row.status as ApprovalStatus,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    decidedAt: num(row.decided_at),
    expiresAt: num(row.expires_at) ?? 0,
    reason: row.reason,
    createdAt: num(row.created_at) ?? 0,
  };
}

export interface CreateApprovalInput {
  tenantId: string;
  sessionId: string;
  alertId?: string | null;
  action: ApprovalAction;
  requestedBy: string;
  /** Epoch ms after which the request can no longer be approved. */
  expiresAt: number;
  nowMs: number;
}

export type DecideOutcome =
  | { ok: true; approval: ApprovalRequest }
  | { ok: false; code: "not_found" | "already_decided" | "expired" | "wrong_tenant" };

export interface ApprovalStoreDeps {
  sql: SqlClient;
  idGen?: () => string;
}

export class SqlApprovalStore {
  private readonly sql: SqlClient;
  private readonly idGen: () => string;

  constructor(deps: ApprovalStoreDeps) {
    this.sql = deps.sql;
    this.idGen = deps.idGen ?? (() => `apr_${randomBytes(12).toString("hex")}`);
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    const id = this.idGen();
    await this.sql
      .prepare(
        `INSERT INTO approval_requests (id, tenant_id, session_id, alert_id, action,
           status, requested_by, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        id,
        input.tenantId,
        input.sessionId,
        input.alertId ?? null,
        JSON.stringify(input.action),
        input.requestedBy,
        input.expiresAt,
        input.nowMs,
      )
      .run();
    const created = await this.get(id);
    if (!created) throw new Error(`approval_requests insert lost row ${id}`);
    return created;
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    const row = await this.sql
      .prepare(`SELECT ${APPROVAL_COLS} FROM approval_requests WHERE id = ?`)
      .bind(id)
      .first<ApprovalRow>();
    return row ? rowToApproval(row) : null;
  }

  /** Tenant-scoped queue listing for the console route. */
  async list(
    tenantId: string,
    filters: { status?: ApprovalStatus; limit?: number } = {},
  ): Promise<ApprovalRequest[]> {
    const clauses = ["tenant_id = ?"];
    const params: unknown[] = [tenantId];
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    params.push(filters.limit ?? 100);
    const rows = await this.sql
      .prepare(
        `SELECT ${APPROVAL_COLS} FROM approval_requests
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(...params)
      .all<ApprovalRow>();
    return (rows.results ?? [])
      .map(rowToApproval)
      .filter((a): a is ApprovalRequest => a !== null);
  }

  /** Human decision. Guarded conditional UPDATE — only a still-pending,
   *  unexpired request in the right tenant can flip. */
  async decide(input: {
    id: string;
    tenantId: string;
    decision: "approve" | "reject";
    decidedBy: string;
    reason?: string;
    nowMs: number;
  }): Promise<DecideOutcome> {
    const row = await this.sql
      .prepare(`SELECT ${APPROVAL_COLS} FROM approval_requests WHERE id = ?`)
      .bind(input.id)
      .first<ApprovalRow>();
    const approval = row ? rowToApproval(row) : null;
    if (!approval) return { ok: false, code: "not_found" };
    if (approval.tenantId !== input.tenantId) return { ok: false, code: "wrong_tenant" };
    if (approval.status === "expired" || input.nowMs > approval.expiresAt) {
      // Also repair the row if the expiry tick hasn't run yet.
      await this.expireOne(input.id, input.nowMs);
      return { ok: false, code: "expired" };
    }
    if (approval.status !== "pending") return { ok: false, code: "already_decided" };
    const res = await this.sql
      .prepare(
        `UPDATE approval_requests
         SET status = ?, decided_by = ?, decided_at = ?, reason = ?
         WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
      )
      .bind(
        input.decision === "approve" ? "approved" : "rejected",
        input.decidedBy,
        input.nowMs,
        input.reason ?? null,
        input.id,
        input.tenantId,
      )
      .run();
    if (res.meta.changes === 0) return { ok: false, code: "already_decided" };
    const updated = await this.get(input.id);
    return updated ? { ok: true, approval: updated } : { ok: false, code: "not_found" };
  }

  /** Flip pending requests past their expiry. Returns the flipped count. */
  async expireStale(nowMs: number): Promise<number> {
    const res = await this.sql
      .prepare(
        `UPDATE approval_requests SET status = 'expired'
         WHERE status = 'pending' AND expires_at < ?`,
      )
      .bind(nowMs)
      .run();
    return res.meta.changes;
  }

  private async expireOne(id: string, nowMs: number): Promise<void> {
    await this.sql
      .prepare(
        `UPDATE approval_requests SET status = 'expired'
         WHERE id = ? AND status = 'pending' AND expires_at < ?`,
      )
      .bind(id, nowMs)
      .run();
  }
}
