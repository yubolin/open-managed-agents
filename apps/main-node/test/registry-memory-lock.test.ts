// Bind-vs-freeze gate — SessionRegistry.bindMemoryStore + build() freeze.
//
// Two review rounds shaped this:
//  - P1 (TOCTOU): a plain isBuilt() check left a race where a bind could
//    commit after build froze the mount list. The registry serializes
//    "check-not-built + write" with build() per session (in-process half).
//  - P1 (multi-replica): in-process state alone doesn't cover PG mode with
//    multiple oma-server replicas and no sticky routing on /v1/* — a
//    replica with an empty map must still reject post-freeze binds. So
//    build() persists sessions.memory_frozen_at BEFORE reading the binding
//    list, and the bind write is a conditional INSERT that only lands
//    while that flag is NULL (DB half).
//
// Invariant under test (the reviewer's acceptance bar):
//   bind returns "bound" (201)  ⇔  the frozen snapshot includes the store.
// The snapshot's mount side is observed via the orchestrator.provision
// call — remindersFromMounts is a pure transform of that exact list
// (covered separately), so mount presence ⇔ reminder presence.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootstrapTestDb,
  type TestDb,
} from "./_helpers/bootstrap-test-db.js";
import { createSqliteMemoryStoreService } from "@open-managed-agents/memory-store";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import { SessionRegistry } from "../src/registry.js";
import type { OrchestratorMemoryMount } from "@open-managed-agents/sandbox/orchestrator";

const TENANT = "tenant-lock";
const NOW = 1_700_000_000_000;

let testDb: TestDb | undefined;

beforeAll(async () => {
  testDb = await bootstrapTestDb({ foreignKeys: false });
});

afterAll(() => {
  testDb?.cleanup();
});

function memoryService() {
  return createSqliteMemoryStoreService({
    db: testDb!.drz,
    blobs: new InMemoryBlobStore(),
  });
}

async function seedSession(sid: string): Promise<void> {
  await testDb!.sql
    .prepare(`INSERT INTO sessions (id, tenant_id, status, created_at) VALUES (?, ?, ?, ?)`)
    .bind(sid, TENANT, "idle", NOW)
    .run();
}

async function frozenFlag(sid: string): Promise<number | null> {
  const r = await testDb!.sql
    .prepare(`SELECT memory_frozen_at FROM sessions WHERE id = ?`)
    .bind(sid)
    .first<{ memory_frozen_at: number | null }>();
  return r?.memory_frozen_at ?? null;
}

async function bindingRows(sid: string): Promise<Array<{ store_id: string }>> {
  const r = await testDb!.sql
    .prepare(`SELECT store_id FROM session_memory_stores WHERE session_id = ?`)
    .bind(sid)
    .all<{ store_id: string }>();
  return r.results ?? [];
}

/** Build a registry wired to the real test DB but with inert runtime
 *  stubs. Captures the memoryMounts each session's build() provisions —
 *  the exact list the frozen reminders snapshot derives from.
 *  `failFirstNProvisions` makes the orchestrator throw for the first N
 *  provision calls (build-failure recovery tests). */
function makeRegistry(opts: { failFirstNProvisions?: number } = {}) {
  const provisioned = new Map<string, OrchestratorMemoryMount[]>();
  let failuresLeft = opts.failFirstNProvisions ?? 0;
  const registry = new SessionRegistry({
    sql: testDb!.sql,
    hub: { publish: () => {}, attach: () => () => {} } as never,
    agentsService: {
      get: async () => ({
        id: "agent-stub",
        name: "stub",
        model: "stub-model",
        system: "",
        version: 1,
      }),
    } as never,
    memoryService: memoryService(),
    sandboxOrchestrator: {
      provision: async (_sandbox, o: { sessionId: string; memoryMounts: OrchestratorMemoryMount[] }) => {
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new Error("transient sandbox provisioning failure");
        }
        provisioned.set(o.sessionId, o.memoryMounts);
      },
    } as never,
    newEventLog: (() => ({})) as never,
    buildSandbox: async () => ({}) as never,
    sandboxWorkdirRoot: "/tmp/oma-lock-test",
    buildModel: async () => ({}) as never,
    buildTools: async () => ({}),
    buildHarness: () => ({ run: async () => {} }),
    buildHarnessContext: async () => ({}),
  });
  return { registry, provisioned };
}

describe("SessionRegistry.bindMemoryStore (bind-vs-freeze gate)", () => {
  it("bind before first build → bound, snapshot includes the store", async () => {
    const { registry, provisioned } = makeRegistry();
    const sid = "sess-lock-pre";
    await seedSession(sid);
    const store = await memoryService().createStore({ tenantId: TENANT, name: "pre-bind" });

    const res = await registry.bindMemoryStore({
      sessionId: sid, tenantId: TENANT, storeId: store.id, access: "read_write",
    });
    expect(res).toBe("bound");

    await registry.getOrCreate(sid, TENANT);
    const mounts = provisioned.get(sid)!;
    expect(mounts.map((m) => m.storeId)).toContain(store.id);
    expect(await frozenFlag(sid)).not.toBeNull();
  });

  it("bind after build → frozen, no row written", async () => {
    const { registry, provisioned } = makeRegistry();
    const sid = "sess-lock-post";
    await seedSession(sid);
    const store = await memoryService().createStore({ tenantId: TENANT, name: "post-bind" });

    await registry.getOrCreate(sid, TENANT);
    const res = await registry.bindMemoryStore({
      sessionId: sid, tenantId: TENANT, storeId: store.id, access: "read_write",
    });
    expect(res).toBe("frozen");
    expect(await bindingRows(sid)).toEqual([]);
    expect(provisioned.get(sid) ?? []).toEqual([]);
  });

  it("bind of unknown store → store_not_found, no row written", async () => {
    const { registry } = makeRegistry();
    const sid = "sess-lock-404";
    await seedSession(sid);

    const res = await registry.bindMemoryStore({
      sessionId: sid, tenantId: TENANT, storeId: "ms_does_not_exist", access: "read_write",
    });
    expect(res).toBe("store_not_found");
    expect(await bindingRows(sid)).toEqual([]);
  });

  it("raced bind + first build never drift: bound ⇔ in snapshot", async () => {
    const svc = memoryService();
    // JS is single-threaded, so the HTTP-level race resolves to one of
    // two deterministic interleavings: the bind lands BEFORE getOrCreate's
    // sync map.set (bind wins), or after (build wins). Cover both, many
    // times, and assert the reviewer's invariant on every round:
    // "bound" ⇒ in the frozen snapshot; else "frozen" and absent.
    const rounds = 20;
    for (let i = 0; i < rounds; i++) {
      const bindFirst = i % 2 === 0;
      const { registry, provisioned } = makeRegistry();
      const sid = `sess-lock-race-${i}`;
      await seedSession(sid);
      const store = await svc.createStore({ tenantId: TENANT, name: `race-store-${i}` });

      let res: "bound" | "frozen" | "store_not_found";
      if (bindFirst) {
        // Bind completes at the gate before the first turn arrives.
        res = await registry.bindMemoryStore({
          sessionId: sid, tenantId: TENANT, storeId: store.id, access: "read_write",
        });
        await registry.getOrCreate(sid, TENANT);
      } else {
        // First turn arrives while the bind request is still parsing its
        // body / looking up the store; by the time it reaches the gate
        // the machine is built (or building) → must conflict.
        const entryP = registry.getOrCreate(sid, TENANT);
        res = await registry.bindMemoryStore({
          sessionId: sid, tenantId: TENANT, storeId: store.id, access: "read_write",
        });
        await entryP;
      }

      const mounts = provisioned.get(sid) ?? [];
      const included = mounts.some((m) => m.storeId === store.id);
      // THE invariant — no third state exists.
      expect(included).toBe(res === "bound");
      // And the outcome matches the interleaving (no accidental drift
      // either way): bind-first always lands, build-first always rejects.
      expect(res === "bound").toBe(bindFirst);
    }
  }, 60_000);

  it("build failure does not fake-freeze: fail → bindable → rebuild mounts it", async () => {
    const { registry, provisioned } = makeRegistry({ failFirstNProvisions: 1 });
    const sid = "sess-lock-fail";
    await seedSession(sid);
    const store = await memoryService().createStore({ tenantId: TENANT, name: "fail-bind" });

    // First build fails (transient sandbox error). Nothing was mounted —
    // the session must NOT be left permanently "built"/frozen.
    await expect(registry.getOrCreate(sid, TENANT)).rejects.toThrow(/transient/);
    expect(registry.isBuilt(sid)).toBe(false);
    // The DB freeze flag set at build start was cleared on failure.
    expect(await frozenFlag(sid)).toBeNull();

    // A bind now lands like it would for a never-built session.
    const res = await registry.bindMemoryStore({
      sessionId: sid, tenantId: TENANT, storeId: store.id, access: "read_write",
    });
    expect(res).toBe("bound");

    // Second build succeeds and the frozen snapshot includes the bind.
    await registry.getOrCreate(sid, TENANT);
    expect(registry.isBuilt(sid)).toBe(true);
    expect((provisioned.get(sid) ?? []).map((m) => m.storeId)).toContain(store.id);
    expect(await frozenFlag(sid)).not.toBeNull();
  });

  it("multi-replica: freeze persisted in DB rejects binds on a replica with an empty map", async () => {
    // Simulates two oma-server replicas over one database: A built the
    // machine (and froze), B's in-process map is empty. Without the DB
    // flag, B would accept the bind and return 201 → drift.
    const a = makeRegistry();
    const b = makeRegistry();
    const sid = "sess-lock-replica";
    await seedSession(sid);
    const store = await memoryService().createStore({ tenantId: TENANT, name: "replica-bind" });

    await a.registry.getOrCreate(sid, TENANT);
    expect(b.registry.isBuilt(sid)).toBe(false); // B has never seen it

    const res = await b.registry.bindMemoryStore({
      sessionId: sid, tenantId: TENANT, storeId: store.id, access: "read_write",
    });
    expect(res).toBe("frozen");
    expect(await bindingRows(sid)).toEqual([]);
  });

  it("multi-replica: bind committed on B is in A's frozen snapshot", async () => {
    const a = makeRegistry();
    const b = makeRegistry();
    const sid = "sess-lock-replica2";
    await seedSession(sid);
    const store = await memoryService().createStore({ tenantId: TENANT, name: "replica-bind-2" });

    const res = await b.registry.bindMemoryStore({
      sessionId: sid, tenantId: TENANT, storeId: store.id, access: "read_write",
    });
    expect(res).toBe("bound");

    // First turn hits replica A — its build must mount what B committed.
    await a.registry.getOrCreate(sid, TENANT);
    expect((a.provisioned.get(sid) ?? []).map((m) => m.storeId)).toContain(store.id);
    expect(await frozenFlag(sid)).not.toBeNull();
  });

  it("isBuilt reflects the gate state used by probes", async () => {
    const { registry } = makeRegistry();
    const sid = "sess-lock-isbuilt";
    await seedSession(sid);
    expect(registry.isBuilt(sid)).toBe(false);
    await registry.getOrCreate(sid, TENANT);
    expect(registry.isBuilt(sid)).toBe(true);
  });
});
