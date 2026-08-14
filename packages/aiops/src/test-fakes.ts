// In-memory AiopsAlertStore — test double for the store port, mirroring
// packages/integrations-core/src/test-fakes.ts conventions.

import type {
  AiopsAlert,
  InsertDedupResult,
  NormalizedAlertInput,
} from "./domain.js";
import { AIOPS_SEVERITY_ORDER } from "./domain.js";
import { withinDedupWindow } from "./fingerprint.js";
import type { AiopsAlertStore, AlertListFilters } from "./store.js";

let nextId = 1;

export class InMemoryAiopsAlertStore implements AiopsAlertStore {
  readonly rows: AiopsAlert[] = [];
  idGen: () => string = () => `alert_${nextId++}`;

  async insertDedup(
    tenantId: string,
    input: NormalizedAlertInput,
    dedupWindowMs: number,
    nowMs: number,
  ): Promise<InsertDedupResult> {
    const existing = this.rows.find(
      (r) =>
        r.tenantId === tenantId &&
        r.fingerprint === input.fingerprint &&
        r.status !== "resolved" &&
        r.status !== "deduped",
    );
    if (
      existing &&
      withinDedupWindow(existing.lastSeenAt, nowMs, dedupWindowMs)
    ) {
      // Immutable update: fold the occurrence into a new row object.
      const idx = this.rows.indexOf(existing);
      this.rows[idx] = {
        ...existing,
        dedupCount: existing.dedupCount + 1,
        lastSeenAt: nowMs,
        severity:
          AIOPS_SEVERITY_ORDER[input.severity] > AIOPS_SEVERITY_ORDER[existing.severity]
            ? input.severity
            : existing.severity,
        endsAt: input.endsAt ?? existing.endsAt,
      };
      return { alert: this.rows[idx], deduped: true };
    }
    // A same-fingerprint row outside the window (or resolved) stays as
    // history; the new occurrence opens a fresh row.
    const alert: AiopsAlert = {
      id: this.idGen(),
      tenantId,
      source: input.source,
      fingerprint: input.fingerprint,
      severity: input.severity,
      name: input.name,
      labels: input.labels,
      annotations: input.annotations,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      dedupCount: 1,
      lastSeenAt: nowMs,
      sessionId: null,
      status: "new",
      error: null,
      createdAt: nowMs,
    };
    this.rows.push(alert);
    return { alert, deduped: false };
  }

  async claimNew(limit: number, nowMs: number): Promise<AiopsAlert[]> {
    const claimed: AiopsAlert[] = [];
    for (let i = 0; i < this.rows.length && claimed.length < limit; i++) {
      if (this.rows[i].status !== "new") continue;
      this.rows[i] = { ...this.rows[i], status: "dispatching" };
      claimed.push(this.rows[i]);
    }
    void nowMs;
    return claimed;
  }

  async attachSession(alertId: string, sessionId: string): Promise<void> {
    this.mutate(alertId, (r) => ({ ...r, sessionId, status: "dispatched" }));
  }

  async attachError(alertId: string, message: string): Promise<void> {
    this.mutate(alertId, (r) => ({ ...r, status: "error", error: message }));
  }

  async getOpenByFingerprint(
    tenantId: string,
    fingerprint: string,
  ): Promise<AiopsAlert | null> {
    return (
      this.rows.find(
        (r) =>
          r.tenantId === tenantId &&
          r.fingerprint === fingerprint &&
          (r.status === "dispatched" || r.status === "dispatching"),
      ) ?? null
    );
  }

  async get(alertId: string): Promise<AiopsAlert | null> {
    return this.rows.find((r) => r.id === alertId) ?? null;
  }

  async list(filters: AlertListFilters): Promise<AiopsAlert[]> {
    let out = [...this.rows];
    if (filters.severity) out = out.filter((r) => r.severity === filters.severity);
    if (filters.status) out = out.filter((r) => r.status === filters.status);
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out.slice(0, filters.limit ?? 100);
  }

  async markResolved(alertId: string, endsAt: number): Promise<void> {
    this.mutate(alertId, (r) => ({ ...r, status: "resolved", endsAt }));
  }

  private mutate(
    alertId: string,
    fn: (row: AiopsAlert) => AiopsAlert,
  ): void {
    const idx = this.rows.findIndex((r) => r.id === alertId);
    if (idx >= 0) this.rows[idx] = fn(this.rows[idx]);
  }
}
