// AIOps alert tables — SQLite schema-behavior + migration tests.
//
// Mirrors the operations-tables schema test contract, over migrations-sqlite
// 0008 (prod shape FK=OFF) and the D1 0004 migration file:
//
//   1. foreign_keys = ON  — proves the schema DECLARATIONS are correct
//      (composite FKs, CHECKs, partial UNIQUE all enforce) and the migration
//      is idempotent. Schema-correctness contract.
//
//   2. foreign_keys = OFF — the prod shape (main-node runs FK=OFF; see
//      apps/main-node/src/index.ts). The migration's hand-written trigger
//      mirror + append-only guards must keep every criterion holding.
//
//   3. D1 file only (FK=OFF) — the 0004 file itself carries the enforcing
//      mirror (0002 precedent), regardless of D1's disputed runtime pragma.
//
// Both suites get a fresh on-disk temp DB (bootstrapTestDb → mkdtemp).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapTestDb,
  type TestDb,
} from "./_helpers/bootstrap-test-db.js";
import { describeAiopsAlertsTablesCriteria } from "./_helpers/aiops-alerts-tables-criteria.js";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import BetterSqlite3 from "better-sqlite3";

const migrationsFolder = fileURLToPath(
  new URL("../migrations-sqlite", import.meta.url),
);

let testDb: TestDb | undefined; // FK = ON
let testDbOff: TestDb | undefined; // FK = OFF (prod shape)

interface StandaloneDb {
  sql: SqlClient;
  cleanup: () => void;
}

let d1FileDb: StandaloneDb | undefined; // D1 migration files only, FK = OFF

/** The 10 aiops triggers this migration must land (8 FK mirror + 2 I10). */
const AIOPS_TRIGGERS = [
  "trg_fki_alerts_asrc",
  "trg_fku_alerts_asrc",
  "trg_fkd_asrc_alerts",
  "trg_fku_asrc_pk",
  "trg_fki_aev_alert",
  "trg_fku_aev_alert",
  "trg_fkd_alerts_aev",
  "trg_fku_alerts_pk",
  "trg_aev_no_update",
  "trg_aev_no_delete",
].sort() as string[];

beforeAll(async () => {
  testDb = await bootstrapTestDb({ foreignKeys: true });
  testDbOff = await bootstrapTestDb({ foreignKeys: false });
  // Standalone DB from the D1 migration files — 0002 first (runs + the
  // operations trigger context), then 0004 (alert tables, runs column).
  // 0004's suffix is a drizzle random word — resolve by journal idx prefix.
  const d1Dir = fileURLToPath(new URL("../../main/migrations", import.meta.url));
  const d1AlertsFile = readdirSync(d1Dir).find((f) => /^0004_[\w]+\.sql$/.test(f));
  if (!d1AlertsFile) throw new Error("D1 0004 aiops migration file not found");
  const tmpDir = mkdtempSync(join(tmpdir(), "oma-test-"));
  const dbPath = join(tmpDir, "d1-file.db");
  const raw = new BetterSqlite3(dbPath);
  raw.exec("PRAGMA foreign_keys = OFF");
  for (const file of [
    "../../main/migrations/0002_operations_workspace.sql",
    `../../main/migrations/${d1AlertsFile}`,
  ]) {
    const migrationText = readFileSync(
      fileURLToPath(new URL(file, import.meta.url)),
      "utf8",
    );
    for (const statement of migrationText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) raw.exec(trimmed);
    }
  }
  raw.close();
  const sql = await createBetterSqlite3SqlClient(dbPath);
  d1FileDb = {
    sql,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
});

afterAll(() => {
  testDb?.cleanup();
  testDbOff?.cleanup();
  d1FileDb?.cleanup();
});

describe("aiops alert tables @ sqlite (foreign_keys = ON — schema correctness)", () => {
  describeAiopsAlertsTablesCriteria(() => testDb!.sql, randomUUID());

  it("⑭′ migration idempotent + lands 3 tables + 10 triggers + partial unique + runs column", async () => {
    // Re-running migrate must be a no-op (drizzle tracks via
    // __drizzle_migrations).
    expect(() => migrate(testDb!.drz, { migrationsFolder })).not.toThrow();

    const tables = await testDb!.sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
          ('aiops_alert_sources','aiops_alerts','aiops_alert_events')`,
      )
      .all<{ name: string }>();
    expect((tables.results ?? []).map((r) => r.name).sort()).toEqual([
      "aiops_alert_events",
      "aiops_alert_sources",
      "aiops_alerts",
    ]);

    // Partial unique + token unique + FK-target uniques + K4 reverse hop.
    for (const ix of [
      "uq_alerts_active_fingerprint",
      "uq_asrc_token",
      "uq_asrc_tenant_id",
      "uq_alerts_tenant_id",
      "idx_runs_tenant_source_alert",
    ]) {
      const row = await testDb!.sql
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .bind(ix)
        .first<{ name: string }>();
      expect(row?.name, `index ${ix} must exist`).toBe(ix);
    }
    // …and the partial predicate actually shipped with it.
    const partial = await testDb!.sql
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'uq_alerts_active_fingerprint'`)
      .first<{ sql: string }>();
    expect(partial?.sql).toContain("IN ('firing','suppressed')");

    // runs.source_alert_id soft-ref column landed.
    const cols = await testDb!.sql
      .prepare(`PRAGMA table_info(runs)`)
      .all<{ name: string }>();
    expect((cols.results ?? []).map((c) => c.name)).toContain("source_alert_id");

    // The FK=OFF mirror + append-only guards (10 triggers).
    const placeholders = AIOPS_TRIGGERS.map(() => "?").join(",");
    const triggers = await testDb!.sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${placeholders}) ORDER BY name`,
      )
      .bind(...AIOPS_TRIGGERS)
      .all<{ name: string }>();
    expect((triggers.results ?? []).map((r) => r.name)).toEqual(AIOPS_TRIGGERS);
  });
});

describe("aiops alert tables @ sqlite (foreign_keys = OFF — prod shape, triggers enforce)", () => {
  // Under FK=OFF the FOREIGN KEY clauses are inert; the migration's triggers
  // must keep every criterion holding. If any criterion flips here, a
  // trigger is missing or wrong.
  describeAiopsAlertsTablesCriteria(() => testDbOff!.sql, randomUUID());

  it("prod pragma is actually OFF in this suite (guard against a false-green)", async () => {
    const row = await testDbOff!.sql
      .prepare(`PRAGMA foreign_keys`)
      .first<{ foreign_keys: number }>();
    expect(row?.foreign_keys, "this suite must run with FK=OFF").toBe(0);
  });
});

describe("aiops alert tables @ D1 migration file (foreign_keys = OFF — mirror enforces regardless of D1's runtime pragma)", () => {
  // Same rationale as the operations D1-file suite: the trigger mirror makes
  // the D1 FK enforcement dispute irrelevant. This suite proves the 0004
  // file itself carries an enforcing mirror + the append-only guards.
  describeAiopsAlertsTablesCriteria(() => d1FileDb!.sql, randomUUID());

  it("carries the same 10-trigger mirror as migrations-sqlite 0008", async () => {
    const placeholders = AIOPS_TRIGGERS.map(() => "?").join(",");
    const triggers = await d1FileDb!.sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${placeholders}) ORDER BY name`,
      )
      .bind(...AIOPS_TRIGGERS)
      .all<{ name: string }>();
    expect((triggers.results ?? []).map((r) => r.name)).toEqual(AIOPS_TRIGGERS);
  });

  it("adapter pragma is OFF in this suite (guard against a false-green)", async () => {
    const row = await d1FileDb!.sql
      .prepare(`PRAGMA foreign_keys`)
      .first<{ foreign_keys: number }>();
    expect(row?.foreign_keys, "this suite must run with FK=OFF").toBe(0);
  });
});
