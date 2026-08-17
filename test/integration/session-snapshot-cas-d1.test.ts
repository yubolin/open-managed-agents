import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@open-managed-agents/shared";
import { createCfSessionService } from "@open-managed-agents/sessions-store";

describe("Session snapshot CAS @ D1 adapter", () => {
  it("lets exactly one conditional UPDATE win", async () => {
    // Test worker applies the same forward migrations as deployment.
    await SELF.fetch("https://example.com/health");
    const service = createCfSessionService({ db: env.AUTH_DB });
    const suffix = crypto.randomUUID();
    const base: AgentConfig = {
      id: `agent_${suffix}`,
      name: "CAS base",
      model: "claude-sonnet-4-6",
      system: "base",
      tools: [],
      version: 1,
      created_at: new Date().toISOString(),
    };
    const { session } = await service.create({
      tenantId: `tenant_${suffix}`,
      agentId: base.id,
      environmentId: `env_${suffix}`,
      agentSnapshot: base,
    });

    const results = await Promise.allSettled([
      service.updateSnapshot({
        tenantId: session.tenant_id,
        sessionId: session.id,
        expectedHash: session.snapshot_hash!,
        agentSnapshot: { ...base, system: "winner A" },
      }),
      service.updateSnapshot({
        tenantId: session.tenant_id,
        sessionId: session.id,
        expectedHash: session.snapshot_hash!,
        agentSnapshot: { ...base, system: "winner B" },
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "snapshot_hash_mismatch" },
    });
  });

  it("rejects init before finalize and re-reads the persisted snapshot", async () => {
    await SELF.fetch("https://example.com/health");
    const service = createCfSessionService({ db: env.AUTH_DB });
    const suffix = crypto.randomUUID();
    const tenantId = `tenant_init_${suffix}`;
    const agent: AgentConfig = {
      id: `agent_init_${suffix}`,
      name: "Persisted",
      model: "claude-sonnet-4-6",
      system: "persisted system",
      tools: [],
      version: 1,
      created_at: new Date().toISOString(),
    };
    const { session } = await service.create({
      tenantId,
      agentId: agent.id,
      environmentId: `env_${suffix}`,
      agentSnapshot: agent,
    });
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(session.id));
    const init = () =>
      stub.fetch(
        new Request("http://internal/init", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: session.id,
            tenant_id: tenantId,
            agent_id: agent.id,
            environment_id: `env_${suffix}`,
            title: "",
            agent_snapshot: { ...agent, system: "tampered caller snapshot" },
          }),
        }),
      );

    await expect(init().then((response) => response.status)).resolves.toBe(409);
    await service.finalizeSnapshot({
      tenantId,
      sessionId: session.id,
      expectedHash: session.snapshot_hash!,
    });
    await expect(init().then((response) => response.status)).resolves.toBe(200);

    const storedSystem = await runInDurableObject(stub, async (instance) =>
      instance.state.agent_snapshot.system,
    );
    expect(storedSystem).toBe("persisted system");
  });
});
