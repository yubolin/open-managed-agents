// Shared schema-behavior assertions for the three AIOps alert tables.
//
// Runs against any SqlClient (SQLite or PG — the PG adapter normalizes `?`
// to `$n`, so the same `?`-parameterized SQL works on both). Behavior
// criteria (p1-aiops-alerts-spec v0.1 §4/§11):
//
//   ① source webhook_token_hash UNIQUE (token → source single hop)
//   ② source type CHECK (alertmanager / generic)
//   ③ alerts composite FK: unknown + cross-tenant source rejected
//   ④ alerts FK UPDATE: re-pointing to an unknown source rejected
//   ⑤ partial UNIQUE active episode: dup firing rejected; firing + dup
//      suppressed rejected (both statuses are in the active set)
//   ⑥ episode release: resolved/expired frees the fingerprint — a fresh
//      firing inserts, and only THEN re-collides (proves partial, not full)
//   ⑦ status / severity CHECKs (4 + 5 value enums)
//   ⑧ events composite FK: unknown alert rejected on INSERT and UPDATE
//   ⑨ event_type CHECK: 8-type catalog accepted; 'reopened' rejected
//      (PRD 裁决 4/5 — a refire is a new episode row)
//   ⑩ parent delete NO ACTION: source blocked while alerts exist, alert
//      blocked while events exist; unreferenced parents delete fine
//   ⑪ append-only: UPDATE and DELETE on aiops_alert_events rejected (I10)
//   ⑫ parent identity UPDATE blocked while referenced (sources + alerts)
//   ⑬ cross-tenant event rejected (tenant must match the alert's tenant)
//   ⑭ behavioral defaults: status=firing, occurrence_count=1,
//      annotations_json='{}', stale_after_seconds=86400, enabled=1
//   ⑮ intra-row status transition firing→suppressed allowed (same row
//      never collides with its own partial-unique entry)
//
// `runId` scopes every created id so PG cleanup can target only this run's
// rows; SQLite uses a fresh temp DB per run (prefix kept for uniformity).
// PG cleanup cannot DELETE events (append-only trigger), so the PG test
// file flips session_replication_role for teardown.

import { it, expect } from "vitest";
import type { SqlClient } from "@open-managed-agents/sql-client";

const NOW = 1_700_000_000_000;

/** True if a promise rejects (FK / CHECK / UNIQUE / trigger violation). */
async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

export function describeAiopsAlertsTablesCriteria(
  getSql: () => SqlClient,
  runId: string,
): void {
  const id = (s: string): string => `${runId}:${s}`;
  const tenant = id("t1");

  async function insertSource(
    sql: SqlClient,
    sid: string,
    tokenHash: string,
    tn: string = tenant,
  ): Promise<void> {
    await sql
      .prepare(
        `INSERT INTO aiops_alert_sources
           (id, tenant_id, name, type, webhook_token_hash, created_at, updated_at)
         VALUES (?, ?, 'Prometheus AM', 'alertmanager', ?, ?, ?)`,
      )
      .bind(sid, tn, tokenHash, NOW, NOW)
      .run();
  }

  async function insertAlert(
    sql: SqlClient,
    aid: string,
    fp: string,
    sid: string,
    opts: { status?: string; severity?: string; tn?: string } = {},
  ): Promise<void> {
    const { status = "firing", severity = "high", tn = tenant } = opts;
    await sql
      .prepare(
        `INSERT INTO aiops_alerts
           (id, tenant_id, source_id, fingerprint, status, severity, title,
            labels_json, starts_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'High error rate', '{}', ?, ?, ?, ?)`,
      )
      .bind(aid, tn, sid, fp, status, severity, NOW, NOW, NOW, NOW)
      .run();
  }

  async function insertEvent(
    sql: SqlClient,
    eid: string,
    aid: string,
    eventType: string = "ingested",
    tn: string = tenant,
  ): Promise<void> {
    await sql
      .prepare(
        `INSERT INTO aiops_alert_events
           (id, tenant_id, alert_id, event_type, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, 'system:ingest', '{}', ?)`,
      )
      .bind(eid, tn, aid, eventType, NOW)
      .run();
  }

  it("① source webhook_token_hash UNIQUE", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-1"), "hash-aaa");
    expect(
      await rejects(insertSource(sql, id("asrc-2"), "hash-aaa")),
    ).toBe(true);
    // Different hash, same name — fine (name is not unique).
    await insertSource(sql, id("asrc-3"), "hash-bbb");
  });

  it("② source type CHECK", async () => {
    const sql = getSql();
    expect(
      await rejects(
        sql
          .prepare(
            `INSERT INTO aiops_alert_sources
               (id, tenant_id, name, type, webhook_token_hash, created_at, updated_at)
             VALUES (?, ?, 'Zabbix', 'zabbix', 'hash-z', ?, ?)`,
          )
          .bind(id("asrc-bad"), tenant, NOW, NOW)
          .run(),
      ),
    ).toBe(true);
    await sql
      .prepare(
        `INSERT INTO aiops_alert_sources
           (id, tenant_id, name, type, webhook_token_hash, created_at, updated_at)
         VALUES (?, ?, 'Webhook', 'generic', 'hash-g', ?, ?)`,
      )
      .bind(id("asrc-gen"), tenant, NOW, NOW)
      .run();
  });

  it("③ alerts composite FK: unknown and cross-tenant source rejected", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-3a"), "hash-3a");
    expect(
      await rejects(insertAlert(sql, id("a-3a"), "fp-3", id("missing"))),
    ).toBe(true);
    expect(
      await rejects(
        insertAlert(sql, id("a-3b"), "fp-3", id("asrc-3a"), {
          tn: id("other"),
        }),
      ),
    ).toBe(true);
  });

  it("④ alerts FK UPDATE: re-pointing to an unknown source rejected", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-4"), "hash-4");
    await insertAlert(sql, id("a-4"), "fp-4", id("asrc-4"));
    expect(
      await rejects(
        sql
          .prepare(`UPDATE aiops_alerts SET source_id = ? WHERE id = ?`)
          .bind(id("missing"), id("a-4"))
          .run(),
      ),
    ).toBe(true);
  });

  it("⑤ partial UNIQUE active episode: firing dup and firing+suppressed dup rejected", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-5"), "hash-5");
    await insertAlert(sql, id("a-5a"), "fp-5", id("asrc-5"));
    expect(
      await rejects(insertAlert(sql, id("a-5b"), "fp-5", id("asrc-5"))),
    ).toBe(true);
    // suppressed is in the active set too — collides with the firing row.
    expect(
      await rejects(
        insertAlert(sql, id("a-5c"), "fp-5", id("asrc-5"), {
          status: "suppressed",
        }),
      ),
    ).toBe(true);
  });

  it("⑥ episode release: terminal status frees the fingerprint", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-6"), "hash-6");
    await insertAlert(sql, id("a-6a"), "fp-6", id("asrc-6"));
    await sql
      .prepare(
        `UPDATE aiops_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`,
      )
      .bind(NOW, id("a-6a"))
      .run();
    // Fingerprint free again: a fresh episode row lands…
    await insertAlert(sql, id("a-6b"), "fp-6", id("asrc-6"));
    // …and only now re-collides (partial unique, not a full unique).
    expect(
      await rejects(insertAlert(sql, id("a-6c"), "fp-6", id("asrc-6"))),
    ).toBe(true);
    // Both episode rows coexist with the same fingerprint.
    const rows = await sql
      .prepare(`SELECT COUNT(*) AS n FROM aiops_alerts WHERE fingerprint = ?`)
      .bind("fp-6")
      .first<{ n: number }>();
    expect(Number(rows?.n)).toBe(2);
  });

  it("⑦ status and severity CHECKs", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-7"), "hash-7");
    expect(
      await rejects(
        insertAlert(sql, id("a-7a"), "fp-7a", id("asrc-7"), {
          status: "closed",
        }),
      ),
    ).toBe(true);
    expect(
      await rejects(
        insertAlert(sql, id("a-7b"), "fp-7b", id("asrc-7"), {
          severity: "sev1",
        }),
      ),
    ).toBe(true);
    for (const [i, status] of [
      "firing",
      "resolved",
      "suppressed",
      "expired",
    ].entries()) {
      await insertAlert(sql, id(`a-7s-${i}`), id(`fp-7s-${i}`), id("asrc-7"), {
        status,
      });
    }
    for (const [i, severity] of [
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ].entries()) {
      await insertAlert(sql, id(`a-7v-${i}`), id(`fp-7v-${i}`), id("asrc-7"), {
        severity,
      });
    }
  });

  it("⑧ events composite FK: unknown alert rejected on INSERT and UPDATE", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-8"), "hash-8");
    await insertAlert(sql, id("a-8"), "fp-8", id("asrc-8"));
    expect(
      await rejects(insertEvent(sql, id("aev-8a"), id("missing"))),
    ).toBe(true);
    await insertEvent(sql, id("aev-8b"), id("a-8"));
    expect(
      await rejects(
        sql
          .prepare(`UPDATE aiops_alert_events SET alert_id = ? WHERE id = ?`)
          .bind(id("missing"), id("aev-8b"))
          .run(),
      ),
    ).toBe(true);
  });

  it("⑨ event_type CHECK: 8-type catalog accepted, 'reopened' rejected", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-9"), "hash-9");
    await insertAlert(sql, id("a-9"), "fp-9", id("asrc-9"));
    expect(
      await rejects(insertEvent(sql, id("aev-9bad"), id("a-9"), "reopened")),
    ).toBe(true);
    for (const [i, type] of [
      "ingested",
      "severity_escalated",
      "resolved",
      "suppressed",
      "unsuppressed",
      "expired",
      "run_triggered",
      "run_completed",
    ].entries()) {
      await insertEvent(sql, id(`aev-9-${i}`), id("a-9"), type);
    }
  });

  it("⑩ parent delete NO ACTION: blocked while referenced, free otherwise", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-10"), "hash-10");
    await insertAlert(sql, id("a-10a"), "fp-10a", id("asrc-10"));
    expect(
      await rejects(
        sql
          .prepare(`DELETE FROM aiops_alert_sources WHERE id = ?`)
          .bind(id("asrc-10"))
          .run(),
      ),
    ).toBe(true);
    // Alert without events deletes fine…
    await sql
      .prepare(`DELETE FROM aiops_alerts WHERE id = ?`)
      .bind(id("a-10a"))
      .run();
    // …which frees the source.
    await sql
      .prepare(`DELETE FROM aiops_alert_sources WHERE id = ?`)
      .bind(id("asrc-10"))
      .run();

    // Alert WITH an event is history — permanently blocked.
    await insertSource(sql, id("asrc-10b"), "hash-10b");
    await insertAlert(sql, id("a-10b"), "fp-10b", id("asrc-10b"));
    await insertEvent(sql, id("aev-10b"), id("a-10b"));
    expect(
      await rejects(
        sql
          .prepare(`DELETE FROM aiops_alerts WHERE id = ?`)
          .bind(id("a-10b"))
          .run(),
      ),
    ).toBe(true);
  });

  it("⑪ append-only: UPDATE and DELETE on aiops_alert_events rejected", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-11"), "hash-11");
    await insertAlert(sql, id("a-11"), "fp-11", id("asrc-11"));
    await insertEvent(sql, id("aev-11"), id("a-11"));
    expect(
      await rejects(
        sql
          .prepare(
            `UPDATE aiops_alert_events SET payload_json = '{"tampered":1}' WHERE id = ?`,
          )
          .bind(id("aev-11"))
          .run(),
      ),
    ).toBe(true);
    expect(
      await rejects(
        sql
          .prepare(`DELETE FROM aiops_alert_events WHERE id = ?`)
          .bind(id("aev-11"))
          .run(),
      ),
    ).toBe(true);
  });

  it("⑫ parent identity UPDATE blocked while referenced", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-12"), "hash-12");
    await insertAlert(sql, id("a-12"), "fp-12", id("asrc-12"));
    expect(
      await rejects(
        sql
          .prepare(`UPDATE aiops_alert_sources SET id = ? WHERE id = ?`)
          .bind(id("asrc-12-new"), id("asrc-12"))
          .run(),
      ),
    ).toBe(true);
    await insertEvent(sql, id("aev-12"), id("a-12"));
    expect(
      await rejects(
        sql
          .prepare(`UPDATE aiops_alerts SET id = ? WHERE id = ?`)
          .bind(id("a-12-new"), id("a-12"))
          .run(),
      ),
    ).toBe(true);
  });

  it("⑬ cross-tenant event rejected", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-13"), "hash-13");
    await insertAlert(sql, id("a-13"), "fp-13", id("asrc-13"));
    expect(
      await rejects(insertEvent(sql, id("aev-13"), id("a-13"), "ingested", id("other"))),
    ).toBe(true);
  });

  it("⑭ behavioral defaults on minimal inserts", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-14"), "hash-14");
    await insertAlert(sql, id("a-14"), "fp-14", id("asrc-14"));
    const alert = await sql
      .prepare(
        `SELECT status, occurrence_count, annotations_json FROM aiops_alerts WHERE id = ?`,
      )
      .bind(id("a-14"))
      .first<{ status: string; occurrence_count: number; annotations_json: string }>();
    expect(alert?.status).toBe("firing");
    expect(Number(alert?.occurrence_count)).toBe(1);
    expect(alert?.annotations_json).toBe("{}");
    const source = await sql
      .prepare(
        `SELECT stale_after_seconds, enabled FROM aiops_alert_sources WHERE id = ?`,
      )
      .bind(id("asrc-14"))
      .first<{ stale_after_seconds: number; enabled: number }>();
    expect(Number(source?.stale_after_seconds)).toBe(86400);
    expect(Number(source?.enabled)).toBe(1);
  });

  it("⑮ intra-row status transition firing→suppressed allowed", async () => {
    const sql = getSql();
    await insertSource(sql, id("asrc-15"), "hash-15");
    await insertAlert(sql, id("a-15"), "fp-15", id("asrc-15"));
    // Same row stays inside the active set — never collides with itself.
    await sql
      .prepare(
        `UPDATE aiops_alerts SET status = 'suppressed', suppress_note = 'noisy test alert' WHERE id = ?`,
      )
      .bind(id("a-15"))
      .run();
    const row = await sql
      .prepare(`SELECT status, suppress_note FROM aiops_alerts WHERE id = ?`)
      .bind(id("a-15"))
      .first<{ status: string; suppress_note: string | null }>();
    expect(row?.status).toBe("suppressed");
    expect(row?.suppress_note).toBe("noisy test alert");
  });
}
