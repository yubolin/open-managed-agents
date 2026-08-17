import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentConfig, SessionEvent } from "@open-managed-agents/shared";
import { SqlEventLog, ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import { createSqliteMemoryStoreService } from "@open-managed-agents/memory-store";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import { SessionRegistry } from "../src/registry.js";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db.js";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await bootstrapTestDb();
  await ensureEventLogSchema(testDb.sql, "sqlite");
});

afterAll(() => testDb.cleanup());

describe("Node child thread frozen snapshot", () => {
  it("uses the requested historical version and remains replayable after Agent deletion", async () => {
    const tenantId = "tenant-thread-snapshot";
    const sessionId = "sess-thread-snapshot";
    const agentId = "agent-child-snapshot";
    const primary: AgentConfig = {
      id: "agent-primary-snapshot",
      name: "Primary",
      model: "test-model",
      system: "primary",
      tools: [],
      version: 1,
      created_at: new Date().toISOString(),
    };
    const historical: AgentConfig = {
      id: agentId,
      name: "Child v1",
      model: "test-model",
      system: "historical system",
      tools: [],
      version: 1,
      created_at: new Date().toISOString(),
    };
    const current: AgentConfig & { tenant_id: string } = {
      ...historical,
      tenant_id: tenantId,
      name: "Child v2",
      system: "current system",
      version: 2,
    };
    let agentDeleted = false;

    await testDb.sql
      .prepare(
        `INSERT INTO sessions
          (id, tenant_id, agent_id, environment_id, title, status,
           agent_snapshot, snapshot_state, snapshot_hash, snapshot_finalized_at,
           created_at)
         VALUES (?, ?, ?, 'env-test', '', 'idle', ?, 'finalized', ?, ?, ?)`,
      )
      .bind(
        sessionId,
        tenantId,
        primary.id,
        JSON.stringify(primary),
        "b".repeat(64),
        Date.now(),
        Date.now(),
      )
      .run();

    const eventLog = new SqlEventLog(testDb.sql, sessionId, () => {});
    const memoryService = createSqliteMemoryStoreService({
      db: testDb.drz,
      blobs: new InMemoryBlobStore(),
    });
    const registry = new SessionRegistry({
      sql: testDb.sql,
      hub: { publish: () => {}, attach: () => () => {} } as never,
      agentsService: {
        get: async () => (agentDeleted ? null : current),
        getVersion: async ({ version }: { version: number }) =>
          version === 1 && !agentDeleted
            ? { agent_id: agentId, tenant_id: tenantId, version: 1, snapshot: historical }
            : null,
      } as never,
      memoryService,
      sandboxOrchestrator: { provision: async () => {} } as never,
      newEventLog: () => eventLog,
      buildSandbox: async () => ({}) as never,
      sandboxWorkdirRoot: "/tmp/oma-thread-snapshot-test",
      buildModel: async () => ({}) as never,
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async (context: unknown) => {
          const ctx = context as { eventLog: SqlEventLog; threadId: string };
          await ctx.eventLog.appendAsync({
            type: "agent.message",
            session_thread_id: ctx.threadId,
            content: [{ type: "text", text: "child reply" }],
          } as unknown as SessionEvent);
        },
      }),
      buildHarnessContext: async (input) => ({
        eventLog: input.eventLog,
        threadId: input.sessionThreadId,
      }),
    });

    const delegate = registry as unknown as {
      runSubAgent(input: {
        sessionId: string;
        tenantId: string;
        agentId: string;
        version: number;
        message: string;
        parentThreadId: string;
      }): Promise<string>;
    };
    await expect(
      delegate.runSubAgent({
        sessionId,
        tenantId,
        agentId,
        version: 1,
        message: "diagnose",
        parentThreadId: "sthr_primary",
      }),
    ).resolves.toBe("child reply");

    agentDeleted = true;
    const stored = await testDb.sql
      .prepare(
        `SELECT agent_version, agent_snapshot, config_hash, hash_algorithm
           FROM session_threads WHERE session_id = ? AND agent_id = ?`,
      )
      .bind(sessionId, agentId)
      .first<{
        agent_version: number;
        agent_snapshot: string;
        config_hash: string;
        hash_algorithm: string;
      }>();

    expect(stored?.agent_version).toBe(1);
    expect(JSON.parse(stored!.agent_snapshot)).toMatchObject({
      version: 1,
      system: "historical system",
    });
    expect(stored?.config_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.hash_algorithm).toBe("sha256:jcs-rfc8785:v1");
  });
});
