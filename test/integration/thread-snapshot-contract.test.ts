// @ts-nocheck
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function freshDoStub() {
  const id = `thread_snapshot_${Math.random().toString(36).slice(2, 10)}`;
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(id));
}

describe("CF child thread snapshot persistence contract", () => {
  it("creates the four frozen snapshot columns in SessionDO SQLite", async () => {
    const stub = freshDoStub();

    const columns = await runInDurableObject(stub, async (instance, state) => {
      instance._ensureCfAgentsSchema();
      return [...state.storage.sql.exec(`PRAGMA table_info(threads)`)].map(
        (row) => row.name,
      );
    });

    expect(columns).toEqual(
      expect.arrayContaining([
        "agent_version",
        "agent_snapshot",
        "config_hash",
        "hash_algorithm",
      ]),
    );
  });

  it("keeps the full snapshot out of the thread list response", async () => {
    const stub = freshDoStub();
    await runInDurableObject(stub, async (instance, state) => {
      instance._ensureCfAgentsSchema();
      instance._state = {
        session_id: "sess_snapshot_contract",
        tenant_id: "tn_snapshot_contract",
        agent_id: "agent_primary",
        agent_snapshot: { name: "Primary" },
      };
      instance._ensurePrimaryThread();
      const existing = new Set(
        [...state.storage.sql.exec(`PRAGMA table_info(threads)`)].map((row) => row.name),
      );
      for (const [name, type] of [
        ["agent_version", "INTEGER"],
        ["agent_snapshot", "TEXT"],
        ["config_hash", "TEXT"],
        ["hash_algorithm", "TEXT"],
      ]) {
        if (!existing.has(name)) {
          state.storage.sql.exec(`ALTER TABLE threads ADD COLUMN ${name} ${type}`);
        }
      }
      state.storage.sql.exec(
        `INSERT INTO threads
          (id, agent_id, agent_name, parent_thread_id, created_at,
           agent_version, agent_snapshot, config_hash, hash_algorithm)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "sthr_snapshot_child",
        "agent_child",
        "Child",
        "sthr_primary",
        Date.now(),
        3,
        JSON.stringify({ id: "agent_child", version: 3, system: "secret prompt" }),
        "a".repeat(64),
        "sha256:jcs-rfc8785:v1",
      );
    });

    const response = await stub.fetch(new Request("http://internal/threads"));
    expect(response.status).toBe(200);
    const body = await response.json();
    const child = body.data.find((thread) => thread.id === "sthr_snapshot_child");

    expect(child).toBeDefined();
    expect(child).not.toHaveProperty("agent_snapshot");
    expect(JSON.stringify(body)).not.toContain("secret prompt");
  });
});
