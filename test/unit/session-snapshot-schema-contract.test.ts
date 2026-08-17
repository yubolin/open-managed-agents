import { describe, expect, it } from "vitest";
import { sessions as cfSessions } from "../../packages/db-schema/src/cf-auth/sessions";
import { sessions as pgSessions } from "../../packages/db-schema/src/node-pg/cf-auth-sessions";
import { session_threads as sqliteThreads } from "../../packages/db-schema/src/node-sqlite/feishu-ops";
import { session_threads as pgThreads } from "../../packages/db-schema/src/node-pg/feishu-ops";

describe("snapshot schema contract", () => {
  it.each([
    ["CF/D1 sessions", cfSessions],
    ["Node/PG sessions", pgSessions],
  ])("adds snapshot lifecycle columns to %s", (_name, table) => {
    expect(table).toHaveProperty("snapshot_state");
    expect(table).toHaveProperty("snapshot_hash");
    expect(table).toHaveProperty("snapshot_finalized_at");
  });

  it.each([
    ["Node/SQLite session_threads", sqliteThreads],
    ["Node/PG session_threads", pgThreads],
  ])("persists the frozen child-agent snapshot on %s", (_name, table) => {
    expect(table).toHaveProperty("agent_version");
    expect(table).toHaveProperty("agent_snapshot");
    expect(table).toHaveProperty("config_hash");
    expect(table).toHaveProperty("hash_algorithm");
  });
});
