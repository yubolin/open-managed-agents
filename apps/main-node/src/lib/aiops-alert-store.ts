// SQL AiopsAlertStore — SqlClient (SQLite + Postgres) implementation of the
// port defined in packages/aiops/src/store.ts.
//
// Semantics mirror the in-memory reference implementation
// (packages/aiops/src/test-fakes.ts) exactly:
//   - insertDedup folds an occurrence into the open (not resolved/deduped)
//     same-fingerprint row when its last_seen_at is inside the window;
//     severity escalates, ends_at fills only when the input carries one.
//   - claimNew flips status='new' → 'dispatching' atomically (single
//     UPDATE … RETURNING guarded on status), so multiple replicas can tick
//     concurrently — the same statement-atomicity philosophy as the
//     Task-2 memory freeze gate.
//
// Enterprise-isolation note: this file (and the rest of the AIOps subsystem)
// is enterprise-line code, deliberately additive to the OpenMA core — see
// docs/aiops-closed-loop.md "升级隔离" for the upgrade-surface rules.

import { randomBytes } from "node:crypto";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  AiopsAlert,
  InsertDedupResult,
  NormalizedAlertInput,
} from "@open-managed-agents/aiops";
import { AIOPS_SEVERITY_ORDER } from "@open-managed-agents/aiops";
import type { AiopsAlertStore, AlertListFilters } from "@open-managed-agents/aiops";
import { withinDedupWindow } from "@open-managed-agents/aiops";

interface AlertRow {
  id: string;
  tenant_id: string;
  source: string;
  fingerprint: string;
  severity: string;
  name: string;
  labels: string;
  annotations: string;
  starts_at: number | string;
  ends_at: number | string | null;
  dedup_count: number | string;
  last_seen_at: number | string;
  session_id: string | null;
  status: string;
  error: string | null;
  created_at: number | string;
}

const ALERT_COLS = `id, tenant_id, source, fingerprint, severity, name, labels, annotations,
  starts_at, ends_at, dedup_count, last_seen_at, session_id, status, error, created_at`;

/** Postgres bigint columns arrive as strings; SQLite as numbers. */
function num(v: number | string | null | undefined): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

function rowToAlert(row: AlertRow): AiopsAlert {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    source: row.source as AiopsAlert["source"],
    fingerprint: row.fingerprint,
    // CHECK constraints guarantee the enums; trust the column.
    severity: row.severity as AiopsAlert["severity"],
    name: row.name,
    labels: safeParse(row.labels),
    annotations: safeParse(row.annotations),
    startsAt: num(row.starts_at),
    endsAt: row.ends_at === null ? null : num(row.ends_at),
    dedupCount: num(row.dedup_count),
    lastSeenAt: num(row.last_seen_at),
    sessionId: row.session_id,
    status: row.status as AiopsAlert["status"],
    error: row.error,
    createdAt: num(row.created_at),
  };
}

function safeParse(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export interface SqlAiopsAlertStoreDeps {
  sql: SqlClient;
  /** Injectable for tests; default `alert_` + 16 hex chars. */
  idGen?: () => string;
}

export class SqlAiopsAlertStore implements AiopsAlertStore {
  private readonly sql: SqlClient;
  private readonly idGen: () => string;

  constructor(deps: SqlAiopsAlertStoreDeps) {
    this.sql = deps.sql;
    this.idGen =
      deps.idGen ?? (() => `alert_${randomBytes(12).toString("hex")}`);
  }

  async insertDedup(
    tenantId: string,
    input: NormalizedAlertInput,
    dedupWindowMs: number,
    nowMs: number,
  ): Promise<InsertDedupResult> {
    const existing = await this.findOpen(tenantId, input.fingerprint);
    if (
      existing &&
      withinDedupWindow(existing.lastSeenAt, nowMs, dedupWindowMs)
    ) {
      return this.foldOccurrence(existing, input, nowMs);
    }
    // No open in-window row: insert a fresh one, guarded so a concurrent
    // same-fingerprint insert can't slip past (changes=0 → fall back to the
    // fold path). Under PG READ COMMITTED two racing inserts can still both
    // pass the guard; the sweeper's fingerprint routing tolerates the rare
    // duplicate (documented in docs/aiops-closed-loop.md).
    const newId = this.idGen();
    const inserted = await this.sql
      .prepare(
        `INSERT INTO aiops_alerts (id, tenant_id, source, fingerprint, severity, name,
           labels, annotations, starts_at, ends_at, dedup_count, last_seen_at, status, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'new', ?
         WHERE NOT EXISTS (
           SELECT 1 FROM aiops_alerts
           WHERE tenant_id = ? AND fingerprint = ?
             AND status NOT IN ('resolved', 'deduped')
             AND last_seen_at >= ? - ?
         )`,
      )
      .bind(
        newId,
        tenantId,
        input.source,
        input.fingerprint,
        input.severity,
        input.name,
        JSON.stringify(input.labels),
        JSON.stringify(input.annotations),
        input.startsAt,
        input.endsAt ?? null,
        nowMs,
        nowMs,
        tenantId,
        input.fingerprint,
        nowMs,
        dedupWindowMs,
      )
      .run();
    if (inserted.meta.changes > 0) {
      const row = await this.getById(newId);
      if (row) return { alert: row, deduped: false };
    }
    // Lost the race (or guard tripped): re-read and fold.
    const open = await this.findOpen(tenantId, input.fingerprint);
    if (open && withinDedupWindow(open.lastSeenAt, nowMs, dedupWindowMs)) {
      return this.foldOccurrence(open, input, nowMs);
    }
    // Extremely unlikely (the competing row resolved between the two reads)
    // — recurse once; the guard now sees no open row.
    return this.insertDedup(tenantId, input, dedupWindowMs, nowMs);
  }

  async claimNew(limit: number, _nowMs: number): Promise<AiopsAlert[]> {
    // Single statement, cross-replica safe: the CTE picks candidates from the
    // statement snapshot; the outer status guard re-checks under PG row locks
    // so a replica that queued behind another only claims rows it actually
    // flipped. Both dialects support WITH + UPDATE … RETURNING.
    const rows = await this.sql
      .prepare(
        `WITH candidates AS (
           SELECT id FROM aiops_alerts WHERE status = 'new'
           ORDER BY created_at ASC, id ASC LIMIT ?
         )
         UPDATE aiops_alerts SET status = 'dispatching'
         WHERE id IN (SELECT id FROM candidates) AND status = 'new'
         RETURNING ${ALERT_COLS}`,
      )
      .bind(limit)
      .all<AlertRow>();
    return (rows.results ?? []).map(rowToAlert);
  }

  async attachSession(alertId: string, sessionId: string): Promise<void> {
    await this.sql
      .prepare(
        `UPDATE aiops_alerts SET session_id = ?, status = 'dispatched' WHERE id = ?`,
      )
      .bind(sessionId, alertId)
      .run();
  }

  async attachError(alertId: string, message: string): Promise<void> {
    await this.sql
      .prepare(`UPDATE aiops_alerts SET status = 'error', error = ? WHERE id = ?`)
      .bind(message, alertId)
      .run();
  }

  async getOpenByFingerprint(
    tenantId: string,
    fingerprint: string,
  ): Promise<AiopsAlert | null> {
    const row = await this.sql
      .prepare(
        `SELECT ${ALERT_COLS} FROM aiops_alerts
         WHERE tenant_id = ? AND fingerprint = ?
           AND status IN ('dispatching', 'dispatched')
         ORDER BY created_at ASC LIMIT 1`,
      )
      .bind(tenantId, fingerprint)
      .first<AlertRow>();
    return row ? rowToAlert(row) : null;
  }

  async get(alertId: string): Promise<AiopsAlert | null> {
    const row = await this.sql
      .prepare(`SELECT ${ALERT_COLS} FROM aiops_alerts WHERE id = ?`)
      .bind(alertId)
      .first<AlertRow>();
    return row ? rowToAlert(row) : null;
  }

  async list(filters: AlertListFilters): Promise<AiopsAlert[]> {
    // Port-compatible list (cross-tenant, scheduler/console internal use
    // only) — the tenant-scoped HTTP surface uses listForTenant below.
    return this.listWhere(filters, null);
  }

  /** Tenant-scoped listing for the /v1/aiops/alerts console route. Kept off
   *  the AiopsAlertStore port (which stays upstream-stable) as a local
   *  extension, per the upgrade-isolation rules. */
  async listForTenant(
    tenantId: string,
    filters: AlertListFilters,
  ): Promise<AiopsAlert[]> {
    return this.listWhere(filters, tenantId);
  }

  async markResolved(alertId: string, endsAt: number): Promise<void> {
    await this.sql
      .prepare(`UPDATE aiops_alerts SET status = 'resolved', ends_at = ? WHERE id = ?`)
      .bind(endsAt, alertId)
      .run();
  }

  private async listWhere(
    filters: AlertListFilters,
    tenantId: string | null,
  ): Promise<AiopsAlert[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (tenantId !== null) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }
    if (filters.severity) {
      clauses.push("severity = ?");
      params.push(filters.severity);
    }
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filters.limit ?? 100);
    const rows = await this.sql
      .prepare(
        `SELECT ${ALERT_COLS} FROM aiops_alerts ${where}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(...params)
      .all<AlertRow>();
    return (rows.results ?? []).map(rowToAlert);
  }

  private async findOpen(
    tenantId: string,
    fingerprint: string,
  ): Promise<AiopsAlert | null> {
    const row = await this.sql
      .prepare(
        `SELECT ${ALERT_COLS} FROM aiops_alerts
         WHERE tenant_id = ? AND fingerprint = ?
           AND status NOT IN ('resolved', 'deduped')
         ORDER BY created_at ASC LIMIT 1`,
      )
      .bind(tenantId, fingerprint)
      .first<AlertRow>();
    return row ? rowToAlert(row) : null;
  }

  private async foldOccurrence(
    existing: AiopsAlert,
    input: NormalizedAlertInput,
    nowMs: number,
  ): Promise<InsertDedupResult> {
    const severity =
      AIOPS_SEVERITY_ORDER[input.severity] > AIOPS_SEVERITY_ORDER[existing.severity]
        ? input.severity
        : existing.severity;
    await this.sql
      .prepare(
        `UPDATE aiops_alerts
         SET dedup_count = dedup_count + 1, last_seen_at = ?,
             severity = ?, ends_at = COALESCE(?, ends_at)
         WHERE id = ?`,
      )
      .bind(nowMs, severity, input.endsAt ?? null, existing.id)
      .run();
    const alert = await this.getById(existing.id);
    return {
      alert:
        alert ?? {
          ...existing,
          dedupCount: existing.dedupCount + 1,
          lastSeenAt: nowMs,
          severity,
          endsAt: input.endsAt ?? existing.endsAt,
        },
      deduped: true,
    };
  }

  private async getById(alertId: string): Promise<AiopsAlert | null> {
    const row = await this.sql
      .prepare(`SELECT ${ALERT_COLS} FROM aiops_alerts WHERE id = ?`)
      .bind(alertId)
      .first<AlertRow>();
    return row ? rowToAlert(row) : null;
  }
}
