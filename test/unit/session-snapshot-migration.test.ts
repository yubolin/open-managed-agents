import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@open-managed-agents/shared";
import {
  SNAPSHOT_MIGRATION_STAGES,
  backfillLegacySessionSnapshot,
} from "../../packages/sessions-store/src/snapshot-migration";

const LEGACY_SNAPSHOT: AgentConfig = {
  id: "agent_legacy_snapshot",
  name: "Legacy snapshot",
  model: "claude-sonnet-4-6",
  system: "persisted before snapshot lifecycle columns existed",
  tools: [],
  version: 4,
  created_at: "2026-08-01T00:00:00.000Z",
};

describe("session snapshot migration policy", () => {
  it("keeps the three migration stages in the approved order", () => {
    expect(SNAPSHOT_MIGRATION_STAGES).toEqual([
      "add_nullable_columns",
      "backfill_with_jcs",
      "enable_new_write_constraints",
    ]);
  });

  it("backfills a non-null legacy snapshot as finalized with a JCS hash", async () => {
    const result = await backfillLegacySessionSnapshot({
      agentSnapshot: LEGACY_SNAPSHOT,
      migratedAt: "2026-08-17T12:00:00.000Z",
    });

    expect(result).toMatchObject({
      snapshotState: "finalized",
      snapshotFinalizedAt: "2026-08-17T12:00:00.000Z",
      hashAlgorithm: "sha256:jcs-rfc8785:v1",
    });
    expect(result.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("classifies a pre-cutover null snapshot explicitly and never as building", async () => {
    const result = await backfillLegacySessionSnapshot({
      agentSnapshot: null,
      migratedAt: "2026-08-17T12:00:00.000Z",
    });

    expect(result).toEqual({
      snapshotState: "legacy_unversioned",
      snapshotHash: null,
      snapshotFinalizedAt: null,
      hashAlgorithm: null,
    });
    expect(result.snapshotState).not.toBe("building");
  });
});
