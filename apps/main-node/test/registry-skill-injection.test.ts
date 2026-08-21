// Integration: the registry's skill read-path wiring (P0a/P0b).
//
// A session whose frozen agent snapshot carries a custom skill must:
//   1. freeze a `skill:<id>` platform reminder into buildHarnessContext
//      (prompt parity with CF session-do.ts:4417-4442)
//   2. write the skill's files into the sandbox at the workdir-relative
//      .skills/ base (session-do.ts:4449-4481 — never /home/user, which
//      would escape the Node workdir jail)
//
// Lib-level format parity is pinned in skill-session.test.ts; this file
// proves the REGISTRY actually invokes it with the frozen snapshot's
// skills and mounts into the provisioned sandbox.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { SqlEventLog, ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import { createSqliteMemoryStoreService } from "@open-managed-agents/memory-store";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import { skillFileR2Key } from "@open-managed-agents/shared";
import { SessionRegistry } from "../src/registry.js";
import type { SkillBucketLike, SkillKvLike } from "../src/lib/skill-session.js";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db.js";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await bootstrapTestDb();
  await ensureEventLogSchema(testDb.sql, "sqlite");
});

afterAll(() => testDb.cleanup());

describe("SessionRegistry skill read-path wiring", () => {
  it("freezes skill reminders + mounts files from the frozen agent snapshot", async () => {
    const tenantId = "tenant-skill-inject";
    const sessionId = "sess-skill-inject";
    const skillId = "skill_ch_itg_deadbeef";
    const version = "2.0.0";
    const skillMd = "---\nname: itg\n---\nIntegration skill instructions.";

    const agent: AgentConfig = {
      id: "agent-skill-inject",
      name: "Skilled",
      model: "test-model",
      system: "base system",
      tools: [],
      version: 1,
      created_at: new Date().toISOString(),
      skills: [{ skill_id: skillId, type: "custom", version }],
    } as AgentConfig;

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
        agent.id,
        JSON.stringify(agent),
        "c".repeat(64),
        Date.now(),
        Date.now(),
      )
      .run();

    const skillKv: SkillKvLike = {
      get: async (k) => {
        if (k === `t:${tenantId}:skill:${skillId}`) {
          return JSON.stringify({
            id: skillId,
            name: "itg-skill",
            display_title: "ITG Skill",
            description: "",
            latest_version: version,
          });
        }
        if (k === `t:${tenantId}:skillver:${skillId}:${version}`) {
          return JSON.stringify({
            files: [{ filename: "SKILL.md", size_bytes: skillMd.length, encoding: "utf8" }],
          });
        }
        return null;
      },
    };
    const skillBlobs: SkillBucketLike = {
      get: async (k) => {
        if (k !== skillFileR2Key(tenantId, skillId, version, "SKILL.md")) return null;
        const bytes = new TextEncoder().encode(skillMd);
        return {
          text: async () => skillMd,
          arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
        };
      },
    };

    const capturedReminders: Array<{ source: string; text: string }> = [];
    const sandboxWrites: Array<{ path: string; bytes: Uint8Array }> = [];

    const registry = new SessionRegistry({
      sql: testDb.sql,
      hub: { publish: () => {}, attach: () => () => {} } as never,
      agentsService: { get: async () => null } as never,
      memoryService: createSqliteMemoryStoreService({
        db: testDb.drz,
        blobs: new InMemoryBlobStore(),
      }),
      sandboxOrchestrator: { provision: async () => {} } as never,
      skillKv,
      skillBlobs,
      newEventLog: () => new SqlEventLog(testDb.sql, sessionId, () => {}),
      buildSandbox: async () =>
        ({
          writeFileBytes: async (path: string, bytes: Uint8Array) => {
            sandboxWrites.push({ path, bytes });
          },
        }) as never,
      sandboxWorkdirRoot: "/tmp/oma-skill-inject-test",
      buildModel: async () => ({}) as never,
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => {
        capturedReminders.push(...(input as { platformReminders: Array<{ source: string; text: string }> }).platformReminders);
        return {};
      },
    });

    const entry = await registry.getOrCreate(sessionId, tenantId);
    await entry.machine.runHarnessTurn(agent.id, {
      type: "user.message",
      content: [{ type: "text", text: "use your skill" }],
    } as UserMessageEvent);

    // 1. Skill reminder frozen into the harness context (CF <skill> format).
    const skillReminder = capturedReminders.find((r) => r.source === `skill:${skillId}`);
    expect(skillReminder).toBeDefined();
    expect(skillReminder!.text).toBe(`<skill name="ITG Skill">\n${skillMd}\n</skill>`);

    // 2. Skill file mounted at the workdir-relative base (not /home/user).
    expect(sandboxWrites).toEqual([
      {
        path: `.skills/itg-skill/SKILL.md`,
        bytes: new TextEncoder().encode(skillMd),
      },
    ]);
  });
});
