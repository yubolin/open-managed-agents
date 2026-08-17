// Operations Workspace tables — SQLite schema-behavior + migration tests.
//
// Two suites over the SAME migration folder (mirrors the feishu-tables
// schema test contract):
//
//   1. foreign_keys = ON  — proves the schema DECLARATIONS are correct
//      (composite FKs, CHECKs, composite UNIQUE all enforce) and the
//      migration is idempotent. Schema-correctness contract.
//
//   2. foreign_keys = OFF — the prod shape (main-node runs FK=OFF; see
//      apps/main-node/src/index.ts). The migration's hand-written trigger
//      mirror must keep every criterion holding under the prod pragma.
//      This repays run-model spec §8 open-item-4 (trigger review at Base A).
//
// Both suites get a fresh on-disk temp DB (bootstrapTestDb → mkdtemp).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapTestDb,
  type TestDb,
} from "./_helpers/bootstrap-test-db.js";
import { describeOperationsTablesCriteria } from "./_helpers/operations-tables-criteria.js";
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

let d1FileDb: StandaloneDb | undefined; // D1 migration file only, FK = OFF

beforeAll(async () => {
  testDb = await bootstrapTestDb({ foreignKeys: true });
  testDbOff = await bootstrapTestDb({ foreignKeys: false });
  // Standalone DB from the D1 migration file only — the six operations
  // tables are self-contained (no consolidated baseline needed).
  const tmpDir = mkdtempSync(join(tmpdir(), "oma-test-"));
  const dbPath = join(tmpDir, "d1-file.db");
  const raw = new BetterSqlite3(dbPath);
  raw.exec("PRAGMA foreign_keys = OFF");
  const migrationText = readFileSync(
    fileURLToPath(
      new URL("../../main/migrations/0002_operations_workspace.sql", import.meta.url),
    ),
    "utf8",
  );
  for (const statement of migrationText.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) raw.exec(trimmed);
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

describe("operations tables @ sqlite (foreign_keys = ON — schema correctness)", () => {
  describeOperationsTablesCriteria(() => testDb!.sql, randomUUID());

  it("⑭′ migration idempotent + lands 6 tables + 14 triggers + FK-target uniques", async () => {
    // Re-running migrate must be a no-op (drizzle tracks via
    // __drizzle_migrations).
    expect(() => migrate(testDb!.drz, { migrationsFolder })).not.toThrow();

    const tables = await testDb!.sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
          ('service_templates','service_template_versions','runs',
           'run_approvals','run_artifacts','run_events')`,
      )
      .all<{ name: string }>();
    expect((tables.results ?? []).map((r) => r.name).sort()).toEqual([
      "run_approvals",
      "run_artifacts",
      "run_events",
      "runs",
      "service_template_versions",
      "service_templates",
    ]);

    // FK-target composite UNIQUEs land as their own UNIQUE INDEX rows.
    for (const uq of [
      "uq_service_templates_tenant_id",
      "uq_runs_tenant_id",
      "uq_run_artifacts_run_type_version",
    ]) {
      const row = await testDb!.sql
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
        )
        .bind(uq)
        .first<{ name: string }>();
      expect(row?.name, `unique index ${uq} must exist`).toBe(uq);
    }

    // The complete FK=OFF declarative mirror (14 triggers) — scoped to this
    // migration's names; the feishu 0002 triggers share the folder/DB.
    const triggers = await testDb!.sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (
           'trg_fki_stv_template','trg_fku_stv_template','trg_fkd_service_templates_stv',
           'trg_fku_service_templates_pk','trg_fki_ra_run','trg_fku_ra_run','trg_fkd_runs_ra',
           'trg_fki_rart_run','trg_fku_rart_run','trg_fkd_runs_rart','trg_fki_re_run',
           'trg_fku_re_run','trg_fkd_runs_re','trg_fku_runs_pk'
         ) ORDER BY name`,
      )
      .all<{ name: string }>();
    expect((triggers.results ?? []).map((r) => r.name)).toEqual([
      "trg_fkd_runs_ra",
      "trg_fkd_runs_rart",
      "trg_fkd_runs_re",
      "trg_fkd_service_templates_stv",
      "trg_fki_ra_run",
      "trg_fki_rart_run",
      "trg_fki_re_run",
      "trg_fki_stv_template",
      "trg_fku_ra_run",
      "trg_fku_rart_run",
      "trg_fku_re_run",
      "trg_fku_runs_pk",
      "trg_fku_service_templates_pk",
      "trg_fku_stv_template",
    ]);
  });
});

describe("operations tables @ sqlite (foreign_keys = OFF — prod shape, triggers enforce)", () => {
  // Under FK=OFF the FOREIGN KEY clauses are inert; the migration's triggers
  // must keep every criterion holding. If any criterion flips here, a
  // trigger is missing or wrong.
  describeOperationsTablesCriteria(() => testDbOff!.sql, randomUUID());

  it("prod pragma is actually OFF in this suite (guard against a false-green)", async () => {
    const row = await testDbOff!.sql
      .prepare(`PRAGMA foreign_keys`)
      .first<{ foreign_keys: number }>();
    expect(row?.foreign_keys, "this suite must run with FK=OFF").toBe(0);
  });
});

describe("operations tables @ D1 migration file (foreign_keys = OFF — mirror enforces regardless of D1's runtime pragma)", () => {
  // Cloudflare docs say D1 enforces FKs by default; the repo's sql-client
  // adapter records the opposite empirical claim (better-sqlite3.ts:150-154).
  // The trigger mirror makes the dispute irrelevant: redundant under
  // enforcement, load-bearing without it. This suite proves the D1 file
  // itself carries an enforcing mirror (run-model spec v0.4.3 §8-4).
  describeOperationsTablesCriteria(() => d1FileDb!.sql, randomUUID());

  it("carries the same 14-trigger mirror as migrations-sqlite 0006", async () => {
    const triggers = await d1FileDb!.sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (
           'trg_fki_stv_template','trg_fku_stv_template','trg_fkd_service_templates_stv',
           'trg_fku_service_templates_pk','trg_fki_ra_run','trg_fku_ra_run','trg_fkd_runs_ra',
           'trg_fki_rart_run','trg_fku_rart_run','trg_fkd_runs_rart','trg_fki_re_run',
           'trg_fku_re_run','trg_fkd_runs_re','trg_fku_runs_pk'
         ) ORDER BY name`,
      )
      .all<{ name: string }>();
    expect((triggers.results ?? []).map((r) => r.name)).toEqual([
      "trg_fkd_runs_ra",
      "trg_fkd_runs_rart",
      "trg_fkd_runs_re",
      "trg_fkd_service_templates_stv",
      "trg_fki_ra_run",
      "trg_fki_rart_run",
      "trg_fki_re_run",
      "trg_fki_stv_template",
      "trg_fku_ra_run",
      "trg_fku_rart_run",
      "trg_fku_re_run",
      "trg_fku_runs_pk",
      "trg_fku_service_templates_pk",
      "trg_fku_stv_template",
    ]);
  });

  it("adapter pragma is OFF in this suite (guard against a false-green)", async () => {
    const row = await d1FileDb!.sql
      .prepare(`PRAGMA foreign_keys`)
      .first<{ foreign_keys: number }>();
    expect(row?.foreign_keys, "this suite must run with FK=OFF").toBe(0);
  });
});
