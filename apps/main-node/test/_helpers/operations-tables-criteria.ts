// Shared schema-behavior assertions for the six Operations Workspace tables.
//
// Runs against any SqlClient (SQLite or PG — the PG adapter normalizes `?`
// to `$n`, so the same `?`-parameterized SQL works on both). Behavior
// criteria (run-model spec v0.4.2 §2):
//
//   ① template code UNIQUE per tenant
//   ② template version UNIQUE per (template_id, version)
//   ③ version composite FK: unknown template rejected, cross-tenant rejected
//   ④ runs.state CHECK — 13-state enum, invalid rejected
//   ⑤ run_approvals.decision CHECK
//   ⑥ run_artifacts.type CHECK
//   ⑦ run_events phase / result / resource_type CHECKs
//   ⑧ MATCH SIMPLE: run_events with run_id NULL insertable (template events)
//   ⑨ run_events run_id non-NULL must exist (INSERT and UPDATE paths)
//   ⑩ parent delete CASCADE: run delete removes approvals + artifacts
//   ⑪ parent delete NO ACTION: run delete blocked while run_events reference
//      it; deleting the events first frees the run
//   ⑫ parent identity UPDATE blocked while referenced (runs + templates)
//   ⑬ run_artifacts monotonic UNIQUE (tenant, run, type, version)
//   ⑮ composite-FK tenant isolation: another tenant's run id rejected
//
// Criterion ⑭ (defaults) is behavioral on both engines and lives here; the
// dialect-specific ⑭′ (migration idempotency + trigger inventory) lives in
// each engine's test file.
//
// `runId` scopes every created id so PG cleanup can delete only this run's
// rows; SQLite uses a fresh temp DB per run (prefix cosmetic, uniformity kept).

import { it, expect } from "vitest";
import type { SqlClient } from "@open-managed-agents/sql-client";

const NOW = 1_700_000_000_000;

/** True if a promise rejects (FK / CHECK / UNIQUE violation). */
async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

export function describeOperationsTablesCriteria(
  getSql: () => SqlClient,
  runId: string,
): void {
  const id = (s: string): string => `${runId}:${s}`;
  const tenant = id("t1");

  async function insertTemplate(
    sql: SqlClient,
    tid: string,
    code: string,
    tn: string = tenant,
  ): Promise<void> {
    await sql
      .prepare(
        `INSERT INTO service_templates
           (id, tenant_id, name, code, category, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'diagnostic', ?, ?, ?)`,
      )
      .bind(tid, tn, "Restart API", code, id("admin"), NOW, NOW)
      .run();
  }

  async function insertVersion(
    sql: SqlClient,
    vid: string,
    tid: string,
    version: number,
    tn: string = tenant,
  ): Promise<void> {
    await sql
      .prepare(
        `INSERT INTO service_template_versions
           (id, template_id, tenant_id, version, agent_binding, form_schema,
            approval_policy, timeout_policy, published_by, published_at)
         VALUES (?, ?, ?, ?, '{}', '{}', '{}', '{}', ?, ?)`,
      )
      .bind(vid, tid, tn, version, id("publisher"), NOW)
      .run();
  }

  async function insertRun(
    sql: SqlClient,
    rid: string,
    state: string = "draft",
    tn: string = tenant,
  ): Promise<void> {
    await sql
      .prepare(
        `INSERT INTO runs
           (id, tenant_id, title, created_by, service_template_id,
            template_version_id, input_parameters, state, created_at, updated_at)
         VALUES (?, ?, 'DB restart', ?, 'stpl-1', 'stv-1', '{}', ?, ?, ?)`,
      )
      .bind(rid, tn, id("applicant"), state, NOW, NOW)
      .run();
  }

  async function insertApproval(
    sql: SqlClient,
    aid: string,
    rid: string,
    tn: string = tenant,
  ): Promise<void> {
    await sql
      .prepare(
        `INSERT INTO run_approvals
           (id, run_id, tenant_id, stage_order, approver_id, decision,
            plan_hash_at_decision, evidence_snapshot_hash_at_decision, created_at)
         VALUES (?, ?, ?, 1, ?, 'approved', 'ph-1', 'eh-1', ?)`,
      )
      .bind(aid, rid, tn, id("approver"), NOW)
      .run();
  }

  async function insertArtifact(
    sql: SqlClient,
    arid: string,
    rid: string,
    version: number = 1,
    tn: string = tenant,
  ): Promise<void> {
    await sql
      .prepare(
        `INSERT INTO run_artifacts
           (id, run_id, tenant_id, type, version, content, content_sha256,
            created_by, created_at)
         VALUES (?, ?, ?, 'plan', ?, 'plan md', 'sha-1', ?, ?)`,
      )
      .bind(arid, rid, tn, version, id("agent"), NOW)
      .run();
  }

  async function insertEvent(
    sql: SqlClient,
    eid: string,
    rid: string | null,
    tn: string = tenant,
  ): Promise<void> {
    await sql
      .prepare(
        `INSERT INTO run_events
           (id, tenant_id, resource_type, resource_id, run_id, actor, action,
            phase, result, trace_id, ts)
         VALUES (?, ?, 'run', ?, ?, '{}', 'run.create', 'intent', 'pending', 'tr-1', ?)`,
      )
      .bind(eid, tn, rid ?? "stpl-1", rid, NOW)
      .run();
  }

  it("① template code UNIQUE per tenant", async () => {
    const sql = getSql();
    await insertTemplate(sql, id("stpl-1"), "restart-api");
    expect(
      await rejects(insertTemplate(sql, id("stpl-2"), "restart-api")),
    ).toBe(true);
  });

  it("② template version UNIQUE per (template_id, version)", async () => {
    const sql = getSql();
    await insertTemplate(sql, id("stpl-2"), "cache-flush");
    await insertVersion(sql, id("stv-1"), id("stpl-2"), 1);
    expect(
      await rejects(insertVersion(sql, id("stv-2"), id("stpl-2"), 1)),
    ).toBe(true);
  });

  it("③ version composite FK: unknown and cross-tenant template rejected", async () => {
    const sql = getSql();
    await insertTemplate(sql, id("stpl-3"), "disk-expand", tenant);
    expect(
      await rejects(insertVersion(sql, id("stv-3"), id("missing"), 1)),
    ).toBe(true);
    expect(
      await rejects(
        insertVersion(sql, id("stv-4"), id("stpl-3"), 2, id("other")),
      ),
    ).toBe(true);
  });

  it("④ runs.state CHECK: invalid rejected, all-13 enumerated accepted", async () => {
    const sql = getSql();
    expect(await rejects(insertRun(sql, id("run-bad"), "exploded"))).toBe(true);
    for (const [i, state] of [
      "draft",
      "submitted",
      "planning",
      "awaiting_approval",
      "approved",
      "rejected",
      "changes_requested",
      "executing",
      "succeeded",
      "failed",
      "interrupted",
      "cancelled",
      "approval_invalidated",
    ].entries()) {
      await insertRun(sql, id(`run-ok-${i}`), state);
    }
  });

  it("⑤ run_approvals.decision CHECK", async () => {
    const sql = getSql();
    await insertRun(sql, id("run-5"));
    expect(
      await rejects(
        sql
          .prepare(
            `INSERT INTO run_approvals
               (id, run_id, tenant_id, stage_order, approver_id, decision,
                plan_hash_at_decision, evidence_snapshot_hash_at_decision, created_at)
             VALUES (?, ?, ?, 1, ?, 'rubber-stamped', 'ph', 'eh', ?)`,
          )
          .bind(id("ra-bad"), id("run-5"), tenant, id("approver"), NOW)
          .run(),
      ),
    ).toBe(true);
  });

  it("⑥ run_artifacts.type CHECK", async () => {
    const sql = getSql();
    await insertRun(sql, id("run-6"));
    expect(
      await rejects(
        sql
          .prepare(
            `INSERT INTO run_artifacts
               (id, run_id, tenant_id, type, version, content, content_sha256,
                created_by, created_at)
             VALUES (?, ?, ?, 'memo', 1, 'x', 'sha', ?, ?)`,
          )
          .bind(id("rart-bad"), id("run-6"), tenant, id("agent"), NOW)
          .run(),
      ),
    ).toBe(true);
  });

  it("⑦ run_events phase / result / resource_type CHECKs", async () => {
    const sql = getSql();
    await insertRun(sql, id("run-7"));
    for (const bad of [
      ["'memo'", "'intent'", "'pending'"],
      ["'run'", "'epilogue'", "'pending'"],
      ["'run'", "'intent'", "'maybe'"],
    ]) {
      expect(
        await rejects(
          sql
            .prepare(
              `INSERT INTO run_events
                 (id, tenant_id, resource_type, resource_id, run_id, actor,
                  action, phase, result, trace_id, ts)
               VALUES (?, ?, ${bad[0]}, ?, ?, '{}', 'x', ${bad[1]}, ${bad[2]}, 'tr', ?)`,
            )
            .bind(id("re-bad"), tenant, id("run-7"), id("run-7"), NOW)
            .run(),
        ),
      ).toBe(true);
    }
  });

  it("⑧ MATCH SIMPLE: run_events run_id NULL insertable", async () => {
    const sql = getSql();
    await insertEvent(sql, id("re-tpl"), null);
    const row = await sql
      .prepare(`SELECT run_id FROM run_events WHERE id = ?`)
      .bind(id("re-tpl"))
      .first<{ run_id: string | null }>();
    expect(row?.run_id).toBeNull();
  });

  it("⑨ run_events run_id non-NULL must exist (INSERT + UPDATE)", async () => {
    const sql = getSql();
    await insertRun(sql, id("run-9"));
    expect(await rejects(insertEvent(sql, id("re-9"), id("missing")))).toBe(
      true,
    );
    await insertEvent(sql, id("re-9-ok"), null);
    expect(
      await rejects(
        sql
          .prepare(`UPDATE run_events SET run_id = ? WHERE id = ?`)
          .bind(id("missing"), id("re-9-ok"))
          .run(),
      ),
    ).toBe(true);
    // Pointing at a real run passes.
    await sql
      .prepare(`UPDATE run_events SET run_id = ? WHERE id = ?`)
      .bind(id("run-9"), id("re-9-ok"))
      .run();
  });

  it("⑩ parent delete CASCADE: run delete removes approvals + artifacts", async () => {
    const sql = getSql();
    await insertRun(sql, id("run-10"));
    await insertApproval(sql, id("ra-10"), id("run-10"));
    await insertArtifact(sql, id("rart-10"), id("run-10"));
    await sql.prepare(`DELETE FROM runs WHERE id = ?`).bind(id("run-10")).run();
    const approvals = await sql
      .prepare(`SELECT id FROM run_approvals WHERE run_id = ?`)
      .bind(id("run-10"))
      .all<{ id: string }>();
    const artifacts = await sql
      .prepare(`SELECT id FROM run_artifacts WHERE run_id = ?`)
      .bind(id("run-10"))
      .all<{ id: string }>();
    expect((approvals.results ?? []).length).toBe(0);
    expect((artifacts.results ?? []).length).toBe(0);
  });

  it("⑪ parent delete NO ACTION: audit events block run delete", async () => {
    const sql = getSql();
    await insertRun(sql, id("run-11"));
    await insertEvent(sql, id("re-11"), id("run-11"));
    expect(
      await rejects(
        sql.prepare(`DELETE FROM runs WHERE id = ?`).bind(id("run-11")).run(),
      ),
    ).toBe(true);
    // Deleting the audit rows first frees the run (retention flow).
    await sql.prepare(`DELETE FROM run_events WHERE id = ?`).bind(id("re-11")).run();
    await sql.prepare(`DELETE FROM runs WHERE id = ?`).bind(id("run-11")).run();
  });

  it("⑫ parent identity UPDATE blocked while referenced (runs + templates)", async () => {
    const sql = getSql();
    await insertRun(sql, id("run-12"));
    await insertApproval(sql, id("ra-12"), id("run-12"));
    expect(
      await rejects(
        sql
          .prepare(`UPDATE runs SET id = ? WHERE id = ?`)
          .bind(id("run-12b"), id("run-12"))
          .run(),
      ),
    ).toBe(true);
    await insertTemplate(sql, id("stpl-12"), "cert-rotate");
    await insertVersion(sql, id("stv-12"), id("stpl-12"), 1);
    expect(
      await rejects(
        sql
          .prepare(`UPDATE service_templates SET id = ? WHERE id = ?`)
          .bind(id("stpl-12b"), id("stpl-12"))
          .run(),
      ),
    ).toBe(true);
  });

  it("⑬ run_artifacts monotonic UNIQUE (tenant, run, type, version)", async () => {
    const sql = getSql();
    await insertRun(sql, id("run-13"));
    await insertArtifact(sql, id("rart-13a"), id("run-13"), 1);
    expect(
      await rejects(insertArtifact(sql, id("rart-13b"), id("run-13"), 1)),
    ).toBe(true);
    // Next version passes.
    await insertArtifact(sql, id("rart-13c"), id("run-13"), 2);
  });

  it("⑭ column defaults: is_active=1, current_approval_stage=1, version=1", async () => {
    const sql = getSql();
    await insertTemplate(sql, id("stpl-14"), "defaults-probe");
    await insertRun(sql, id("run-14"));
    await insertArtifact(sql, id("rart-14"), id("run-14"));
    const tpl = await sql
      .prepare(`SELECT is_active FROM service_templates WHERE id = ?`)
      .bind(id("stpl-14"))
      .first<{ is_active: number | bigint }>();
    const run = await sql
      .prepare(`SELECT current_approval_stage FROM runs WHERE id = ?`)
      .bind(id("run-14"))
      .first<{ current_approval_stage: number | bigint }>();
    const art = await sql
      .prepare(`SELECT version FROM run_artifacts WHERE id = ?`)
      .bind(id("rart-14"))
      .first<{ version: number | bigint }>();
    expect(Number(tpl?.is_active)).toBe(1);
    expect(Number(run?.current_approval_stage)).toBe(1);
    expect(Number(art?.version)).toBe(1);
  });

  it("⑮ composite-FK tenant isolation: cross-tenant run id rejected", async () => {
    const sql = getSql();
    await insertRun(sql, id("run-15"), "draft", tenant);
    expect(
      await rejects(
        insertApproval(sql, id("ra-15"), id("run-15"), id("other")),
      ),
    ).toBe(true);
  });
}
