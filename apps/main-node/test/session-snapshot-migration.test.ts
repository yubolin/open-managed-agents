import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillLegacySessionSnapshots } from "@open-managed-agents/sessions-store";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db.js";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await bootstrapTestDb();
});

afterAll(() => testDb.cleanup());

describe("snapshot application backfill @ Node SQLite", () => {
  it("classifies both legacy shapes and is resumably idempotent", async () => {
    const snapshot = {
      id: "agent-legacy-backfill",
      name: "Legacy",
      model: "test-model",
      system: "legacy",
      tools: [],
      version: 2,
      created_at: new Date().toISOString(),
    };
    await testDb.sql
      .prepare(
        `INSERT INTO sessions
          (id, tenant_id, status, agent_snapshot, created_at)
         VALUES (?, 'tenant-backfill', 'idle', ?, ?),
                (?, 'tenant-backfill', 'idle', NULL, ?)`,
      )
      .bind(
        "sess-legacy-versioned",
        JSON.stringify(snapshot),
        1,
        "sess-legacy-null",
        2,
      )
      .run();

    await expect(
      backfillLegacySessionSnapshots({
        sql: testDb.sql,
        batchSize: 10,
        migratedAt: 1_786_945_200_000,
      }),
    ).resolves.toEqual({ finalized: 1, legacyUnversioned: 1, remaining: 0 });

    const rows = await testDb.sql
      .prepare(
        `SELECT id, snapshot_state, snapshot_hash, snapshot_finalized_at
           FROM sessions WHERE tenant_id = 'tenant-backfill' ORDER BY id`,
      )
      .all<{
        id: string;
        snapshot_state: string;
        snapshot_hash: string | null;
        snapshot_finalized_at: number | null;
      }>();
    expect(rows.results).toEqual([
      {
        id: "sess-legacy-null",
        snapshot_state: "legacy_unversioned",
        snapshot_hash: null,
        snapshot_finalized_at: null,
      },
      {
        id: "sess-legacy-versioned",
        snapshot_state: "finalized",
        snapshot_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        snapshot_finalized_at: 1_786_945_200_000,
      },
    ]);

    await expect(
      backfillLegacySessionSnapshots({ sql: testDb.sql, batchSize: 10 }),
    ).resolves.toEqual({ finalized: 0, legacyUnversioned: 0, remaining: 0 });
  });
});
