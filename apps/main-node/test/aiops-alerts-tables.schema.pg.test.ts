// AIOps alert tables — PG schema-behavior + migration tests.
//
// Runs the exact postgres-js migrator the app uses against PG_TEST_URL
// (migrations 0000..0009). PG enforces FKs unconditionally and the 0009
// migration ships the plpgsql append-only guards, so the SAME criteria that
// prove the SQLite trigger mirror prove native enforcement here.
//
// Skipped unless PG_TEST_URL is set. Run locally with:
//   docker run --rm -p 54329:5432 -e POSTGRES_USER=oma -e POSTGRES_PASSWORD=oma \
//     -e POSTGRES_DB=oma postgres:16-alpine
//   PG_TEST_URL=postgres://oma:oma@127.0.0.1:54329/oma pnpm --filter \
//     @open-managed-agents/main-node test aiops-alerts-tables.schema.pg
//
// SAFETY: bootstrapTestDbPg guards PG_TEST_URL to loopback. Every id this
// run creates is prefixed with `runId:` so afterAll deletes ONLY its own
// rows. Teardown flips session_replication_role = replica so the
// append-only guard and FKs let fixtures be removed (superuser in the test
// container); the role is restored before close.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  bootstrapTestDbPg,
  PG_ENABLED,
  type PgTestDb,
} from "./_helpers/bootstrap-test-db-pg.js";
import { describeAiopsAlertsTablesCriteria } from "./_helpers/aiops-alerts-tables-criteria.js";

const d = PG_ENABLED ? describe : describe.skip;

// Per-run prefix. Every created id becomes `${runId}:...`, so cleanup is a
// single scoped `LIKE '${runId}:%'` per table and cannot collide with real
// data or other runs.
const runId = randomUUID();

let pg: PgTestDb | undefined;

beforeAll(async () => {
  if (!PG_ENABLED) return;
  pg = await bootstrapTestDbPg();
});

afterAll(async () => {
  if (!pg) return;
  const sql = pg.sql;
  const prefix = `${runId}:%`;
  // Children first. Events are append-only-guarded and alerts/sources are
  // NO ACTION-referenced, so teardown suspends triggers + FK checks for the
  // scoped deletes, then restores the role. Cleanup errors are NOT
  // swallowed: capture the first, always restore + close, rethrow.
  let firstErr: unknown;
  try {
    try {
      await sql.prepare(`SET session_replication_role = replica`).run();
    } catch (e) {
      firstErr = e; // non-superuser: fall through to plain scoped deletes
    }
    for (const stmt of [
      `DELETE FROM aiops_alert_events WHERE id LIKE ?`,
      `DELETE FROM aiops_alerts WHERE id LIKE ?`,
      `DELETE FROM aiops_alert_sources WHERE id LIKE ?`,
    ]) {
      try {
        await sql.prepare(stmt).bind(prefix).run();
      } catch (e) {
        if (firstErr === undefined) firstErr = e;
      }
    }
  } finally {
    try {
      await sql.prepare(`SET session_replication_role = DEFAULT`).run();
    } catch {
      // Connection is closing; role reset is best-effort.
    }
    await pg.end();
  }
  if (firstErr !== undefined && process.env.PG_TEST_URL) throw firstErr;
});

d("aiops alert tables @ postgres", () => {
  describeAiopsAlertsTablesCriteria(() => pg!.sql, runId);

  it("migration lands tables + partial unique + append-only triggers and is idempotent", async () => {
    await expect(pg!.migrateAgain()).resolves.toBeUndefined();

    const tables = await pg!.sql
      .prepare(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN
           ('aiops_alert_sources','aiops_alerts','aiops_alert_events')`,
      )
      .all<{ table_name: string }>();
    expect((tables.results ?? []).map((r) => r.table_name).sort()).toEqual([
      "aiops_alert_events",
      "aiops_alert_sources",
      "aiops_alerts",
    ]);

    // Partial unique predicate shipped on PG too. PG normalizes the
    // predicate ('firing'::text casts, spaced commas), so assert the
    // semantic tokens — the behavioral proof is criteria ⑤/⑥.
    const partial = await pg!.sql
      .prepare(
        `SELECT indexdef FROM pg_indexes
         WHERE indexname = 'uq_alerts_active_fingerprint'`,
      )
      .first<{ indexdef: string }>();
    const def = partial?.indexdef ?? "";
    expect(def).toContain("WHERE");
    expect(def).toContain("'firing'");
    expect(def).toContain("'suppressed'");

    // Append-only guards (plpgsql twins of the SQLite trg_aev_* triggers).
    const triggers = await pg!.sql
      .prepare(
        `SELECT trigger_name FROM information_schema.triggers
         WHERE event_object_table = 'aiops_alert_events'
           AND trigger_name IN ('trg_aev_no_update','trg_aev_no_delete')
         ORDER BY trigger_name`,
      )
      .all<{ trigger_name: string }>();
    expect((triggers.results ?? []).map((r) => r.trigger_name)).toEqual([
      "trg_aev_no_delete",
      "trg_aev_no_update",
    ]);
  });
});
