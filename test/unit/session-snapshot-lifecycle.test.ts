import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@open-managed-agents/shared";
import { createInMemorySessionService } from "../../packages/sessions-store/src/test-fakes";

const TENANT = "tn_snapshot_lifecycle";
const AGENT = "agent_snapshot_lifecycle";
const ENVIRONMENT = "env_snapshot_lifecycle";

const SNAPSHOT_A: AgentConfig = {
  id: AGENT,
  name: "Snapshot A",
  model: "claude-sonnet-4-6",
  system: "version A",
  tools: [],
  version: 1,
  created_at: "2026-08-17T00:00:00.000Z",
};

const SNAPSHOT_B: AgentConfig = {
  ...SNAPSHOT_A,
  name: "Snapshot B",
  system: "version B",
};

type SnapshotLifecycleService = {
  updateSnapshot(opts: {
    tenantId: string;
    sessionId: string;
    expectedHash: string;
    agentSnapshot: AgentConfig;
  }): Promise<Record<string, unknown>>;
  finalizeSnapshot(opts: {
    tenantId: string;
    sessionId: string;
    expectedHash: string;
  }): Promise<Record<string, unknown>>;
};

async function createBuildingSession() {
  const { service } = createInMemorySessionService();
  const created = await service.create({
    tenantId: TENANT,
    agentId: AGENT,
    environmentId: ENVIRONMENT,
    agentSnapshot: SNAPSHOT_A,
  });
  return {
    service,
    lifecycle: service as unknown as SnapshotLifecycleService,
    session: created.session as typeof created.session & {
      snapshot_state?: string;
      snapshot_hash?: string;
      snapshot_finalized_at?: string | null;
    },
  };
}

describe("Session snapshot lifecycle contract", () => {
  it("creates a non-legacy snapshot in building state with a content hash", async () => {
    const { session } = await createBuildingSession();

    expect(session.snapshot_state).toBe("building");
    expect(session.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.snapshot_finalized_at).toBeNull();
  });

  it("updates only with the current expected hash, then finalizes idempotently", async () => {
    const { lifecycle, session } = await createBuildingSession();
    const updated = await lifecycle.updateSnapshot({
      tenantId: TENANT,
      sessionId: session.id,
      expectedHash: session.snapshot_hash!,
      agentSnapshot: SNAPSHOT_B,
    });
    const updatedHash = updated.snapshot_hash as string;

    expect(updatedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(updatedHash).not.toBe(session.snapshot_hash);

    const finalized = await lifecycle.finalizeSnapshot({
      tenantId: TENANT,
      sessionId: session.id,
      expectedHash: updatedHash,
    });
    expect(finalized.snapshot_state).toBe("finalized");

    await expect(
      lifecycle.finalizeSnapshot({
        tenantId: TENANT,
        sessionId: session.id,
        expectedHash: updatedHash,
      }),
    ).resolves.toMatchObject({ snapshot_state: "finalized", snapshot_hash: updatedHash });
  });

  it("allows exactly one of two concurrent updates with the same expected hash", async () => {
    const { lifecycle, session } = await createBuildingSession();
    const expectedHash = session.snapshot_hash!;
    const results = await Promise.allSettled([
      lifecycle.updateSnapshot({
        tenantId: TENANT,
        sessionId: session.id,
        expectedHash,
        agentSnapshot: { ...SNAPSHOT_B, system: "winner one" },
      }),
      lifecycle.updateSnapshot({
        tenantId: TENANT,
        sessionId: session.id,
        expectedHash,
        agentSnapshot: { ...SNAPSHOT_B, system: "winner two" },
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "snapshot_hash_mismatch" },
    });
  });

  it("allows exactly one winner when update races finalize", async () => {
    const { lifecycle, session } = await createBuildingSession();
    const expectedHash = session.snapshot_hash!;
    const results = await Promise.allSettled([
      lifecycle.updateSnapshot({
        tenantId: TENANT,
        sessionId: session.id,
        expectedHash,
        agentSnapshot: SNAPSHOT_B,
      }),
      lifecycle.finalizeSnapshot({
        tenantId: TENANT,
        sessionId: session.id,
        expectedHash,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects snapshot mutation after finalize", async () => {
    const { lifecycle, session } = await createBuildingSession();
    await lifecycle.finalizeSnapshot({
      tenantId: TENANT,
      sessionId: session.id,
      expectedHash: session.snapshot_hash!,
    });

    await expect(
      lifecycle.updateSnapshot({
        tenantId: TENANT,
        sessionId: session.id,
        expectedHash: session.snapshot_hash!,
        agentSnapshot: SNAPSHOT_B,
      }),
    ).rejects.toMatchObject({ code: "snapshot_already_finalized" });
  });
});
