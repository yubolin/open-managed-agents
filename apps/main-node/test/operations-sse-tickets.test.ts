// SSE ticket store (Base F3) — shared-truth single-use tickets.
//
// Suites:
//   1. ALWAYS-ON sqlite: dual DrizzleSseTicketStore instances over the SAME
//      on-disk file (two independent connections = two "replicas") prove
//      cross-process mint/consume mutual recognition and atomic single-use.
//   2. ALWAYS-ON route level: operationsRoutes with an injected ticketStore
//      — POST /auth/ticket mints into the shared store, GET stream consumes
//      from it; second stream connect is 401 (single-use at the HTTP gate).
//   2b. Resolver-form injection (F3 P2-①): the per-request seam apps/main
//      uses on CF D1 — resolver truth shared, resolver null → Map fallback.
//   3. PG-gated (PG_TEST_URL): the drizzle adapter over real Postgres —
//      including the bigint→string coercion defense (Number() at the row
//      mapping boundary).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import BetterSqlite3 from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DrizzleSseTicketStore,
  InMemoryOperationsStore,
  OperationsService,
} from "@open-managed-agents/operations-store";
import { operationsRoutes } from "@open-managed-agents/http-routes";
import type { OmaDb } from "@open-managed-agents/db-schema";

const migrationsFolder = fileURLToPath(
  new URL("../migrations-sqlite", import.meta.url),
);

interface DualDb {
  dbA: OmaDb;
  dbB: OmaDb;
  path: string;
  cleanup: () => void;
}

function openDualSqliteDb(): DualDb {
  const tmpDir = mkdtempSync(join(tmpdir(), "oma-tickets-"));
  const dbPath = join(tmpDir, "tickets.db");
  const rawA = new BetterSqlite3(dbPath);
  rawA.exec("PRAGMA foreign_keys = OFF");
  migrate(drizzle(rawA) as BetterSQLite3Database, { migrationsFolder });
  // Second INDEPENDENT connection to the same file — replica B.
  const rawB = new BetterSqlite3(dbPath);
  rawB.exec("PRAGMA foreign_keys = OFF");
  return {
    dbA: drizzle(rawA) as unknown as OmaDb,
    dbB: drizzle(rawB) as unknown as OmaDb,
    path: dbPath,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** Yet another independent connection to the same file — replica C. */
function openExtraConnection(dbPath: string): OmaDb {
  const raw = new BetterSqlite3(dbPath);
  raw.exec("PRAGMA foreign_keys = OFF");
  return drizzle(raw) as unknown as OmaDb;
}

// ──────────────────────────────────────────────────────────────────────
// 1. Cross-replica mutual recognition (sqlite, always on)
// ──────────────────────────────────────────────────────────────────────

describe("SseTicketStore · cross-replica mutual recognition (sqlite)", () => {
  it("t1: replica A mints, replica B consumes — and the win is exclusive", async () => {
    const { dbA, dbB, cleanup } = openDualSqliteDb();
    try {
      const replicaA = new DrizzleSseTicketStore(dbA);
      const replicaB = new DrizzleSseTicketStore(dbB);

      await replicaA.issue({
        token: "tok_cross_replica_1",
        tenantId: "tenant_f3",
        userId: "user_op",
        runId: "run_f3",
        expiresAt: Date.now() + 30_000,
      });

      const consumed = await replicaB.consume("tok_cross_replica_1");
      expect(consumed).not.toBeNull();
      expect(consumed).toMatchObject({
        tenantId: "tenant_f3",
        userId: "user_op",
        runId: "run_f3",
      });
      expect(typeof consumed!.expiresAt).toBe("number");

      // Single-use across processes: even replica A (the minter) cannot
      // consume what replica B already took.
      const stale = await replicaA.consume("tok_cross_replica_1");
      expect(stale).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("t2: sweepExpired reaps never-redeemed tickets", async () => {
    const { dbA, cleanup } = openDualSqliteDb();
    try {
      const store = new DrizzleSseTicketStore(dbA);
      // One shared time base T. First issue runs (and exhausts) the
      // throttled internal sweep on the empty table; the second issue is
      // inside the 30s throttle window, so no internal sweep can reap
      // tok_dead before the EXPLICIT sweep under test.
      const T = Date.now();
      await store.issue({ token: "tok_live", tenantId: "t", userId: "u", expiresAt: T + 60_000 });
      await store.issue({ token: "tok_dead", tenantId: "t", userId: "u", expiresAt: T - 60_000 });

      const swept = await store.sweepExpired(T);
      expect(swept).toBe(1);
      expect(await store.consume("tok_dead")).toBeNull();
      expect(await store.consume("tok_live")).not.toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. Route level — injected ticketStore through operationsRoutes
// ──────────────────────────────────────────────────────────────────────

describe("SseTicketStore · route-level injection (operationsRoutes)", () => {
  it("t3: mint via POST /auth/ticket lands in the injected store; stream consumes; replay is 401", async () => {
    const { dbA, path, cleanup } = openDualSqliteDb();
    try {
      const tenantId = "tenant_f3_route";
      const ticketStore = new DrizzleSseTicketStore(dbA);

      // Service side can stay in-memory — the ticket store is independent.
      const store = new InMemoryOperationsStore();
      const service = new OperationsService(store);
      await store.insertTemplate(
        {
          id: "stpl_f3", tenant_id: tenantId, name: "F3", code: "f3",
          category: "diagnostic", description: "", is_active: 1,
          current_version_id: "stplv_f3", created_by: "system",
          created_at: 1, updated_at: 1,
        },
        {
          id: "stplv_f3", template_id: "stpl_f3", tenant_id: tenantId,
          version: 1, is_active: 1, agent_binding: "{}",
          form_schema: "{}", ui_schema: null, approval_policy: "{}",
          timeout_policy: "{}", changelog: "", published_by: "system",
          published_at: 1,
        },
      );
      const run = await service.createRun({
        tenantId, templateId: "stpl_f3", title: "F3 route",
        inputParameters: {}, actor: { type: "user", id: "user_op" },
        autoSubmit: false,
      });

      const root = new Hono();
      root.use("*", async (c, next) => {
        c.set("tenant_id" as any, tenantId);
        c.set("user_id" as any, "user_op");
        await next();
      });
      root.route(
        "/v1/workspace",
        operationsRoutes(() => service, { ticketStore }),
      );

      // Mint — must persist into the INJECTED store (shared truth).
      const mintRes = await root.request("http://localhost/v1/workspace/auth/ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: run.id }),
      });
      expect(mintRes.status).toBe(200);
      const { ticket } = await mintRes.json<{ ticket: string }>();

      // Prove shared truth: an independent connection to the SAME file
      // (the "other replica") sees the ticket.
      const otherReplica = new DrizzleSseTicketStore(openExtraConnection(path));
      const seen = await otherReplica.consume(ticket);
      expect(seen).toMatchObject({ tenantId, runId: run.id });

      // The ticket is now spent — even the ORIGINAL route must 401.
      const sseRes = await root.request(
        `http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${ticket}`,
      );
      expect(sseRes.status).toBe(401);
    } finally {
      cleanup();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2b. Resolver-form ticketStore (F3 P2-①) — the CF seam: per-request
// resolution, instance semantics unchanged, null → in-process fallback.
// ──────────────────────────────────────────────────────────────────────

describe("SseTicketStore · resolver-form injection (operationsRoutes)", () => {
  it("t5: resolver-returned store is the shared truth — other replica sees the mint", async () => {
    const { dbA, path, cleanup } = openDualSqliteDb();
    try {
      const tenantId = "tenant_f3_resolver";
      const ticketStore = new DrizzleSseTicketStore(dbA);
      const store = new InMemoryOperationsStore();
      const service = new OperationsService(store);
      await store.insertTemplate(
        {
          id: "stpl_f3r", tenant_id: tenantId, name: "F3r", code: "f3r",
          category: "diagnostic", description: "", is_active: 1,
          current_version_id: "stplv_f3r", created_by: "system",
          created_at: 1, updated_at: 1,
        },
        {
          id: "stplv_f3r", template_id: "stpl_f3r", tenant_id: tenantId,
          version: 1, is_active: 1, agent_binding: "{}",
          form_schema: "{}", ui_schema: null, approval_policy: "{}",
          timeout_policy: "{}", changelog: "", published_by: "system",
          published_at: 1,
        },
      );
      const run = await service.createRun({
        tenantId, templateId: "stpl_f3r", title: "F3 resolver",
        inputParameters: {}, actor: { type: "user", id: "user_op" },
        autoSubmit: false,
      });

      const root = new Hono();
      root.use("*", async (c, next) => {
        c.set("tenant_id" as any, tenantId);
        c.set("user_id" as any, "user_op");
        await next();
      });
      root.route(
        "/v1/workspace",
        // RESOLVER form — what apps/main passes (per-request D1).
        operationsRoutes(() => service, { ticketStore: () => ticketStore }),
      );

      const mintRes = await root.request("http://localhost/v1/workspace/auth/ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: run.id }),
      });
      expect(mintRes.status).toBe(200);
      const { ticket } = await mintRes.json<{ ticket: string }>();

      // Shared truth through the resolver path: the OTHER replica
      // (independent connection, same file) consumes it exclusively.
      const otherReplica = new DrizzleSseTicketStore(openExtraConnection(path));
      expect(await otherReplica.consume(ticket)).toMatchObject({ tenantId, runId: run.id });
      // Spent — even the minting route must now 401.
      const sseRes = await root.request(
        `http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${ticket}`,
      );
      expect(sseRes.status).toBe(401);
    } finally {
      cleanup();
    }
  });

  it("t6: resolver declining (null) falls back to the in-process Map", async () => {
    const { dbA, cleanup } = openDualSqliteDb();
    try {
      const tenantId = "tenant_f3_fallback";
      const ticketStore = new DrizzleSseTicketStore(dbA);
      const store = new InMemoryOperationsStore();
      const service = new OperationsService(store);
      await store.insertTemplate(
        {
          id: "stpl_f3f", tenant_id: tenantId, name: "F3f", code: "f3f",
          category: "diagnostic", description: "", is_active: 1,
          current_version_id: "stplv_f3f", created_by: "system",
          created_at: 1, updated_at: 1,
        },
        {
          id: "stplv_f3f", template_id: "stpl_f3f", tenant_id: tenantId,
          version: 1, is_active: 1, agent_binding: "{}",
          form_schema: "{}", ui_schema: null, approval_policy: "{}",
          timeout_policy: "{}", changelog: "", published_by: "system",
          published_at: 1,
        },
      );
      const run = await service.createRun({
        tenantId, templateId: "stpl_f3f", title: "F3 fallback",
        inputParameters: {}, actor: { type: "user", id: "user_op" },
        autoSubmit: false,
      });

      const root = new Hono();
      root.use("*", async (c, next) => {
        c.set("tenant_id" as any, tenantId);
        c.set("user_id" as any, "user_op");
        await next();
      });
      root.route(
        "/v1/workspace",
        operationsRoutes(() => service, { ticketStore: () => null }),
      );

      const mintRes = await root.request("http://localhost/v1/workspace/auth/ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: run.id }),
      });
      expect(mintRes.status).toBe(200);
      const { ticket } = await mintRes.json<{ ticket: string }>();

      // Map path: the minted ticket NEVER touched the shared store…
      expect(await ticketStore.consume(ticket)).toBeNull();
      // …and the in-process gate accepts it (single-use there instead).
      const sseRes = await root.request(
        `http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${ticket}`,
      );
      expect(sseRes.status).toBe(200);
      await sseRes.body?.cancel();
    } finally {
      cleanup();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. PG-gated — adapter over real Postgres (bigint coercion defense)
// ──────────────────────────────────────────────────────────────────────

const PG_URL = process.env.PG_TEST_URL ?? "";
const pgEnabled = PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://");
const d = pgEnabled ? describe : describe.skip;

d("SseTicketStore · real PG", () => {
  it("t4: issue/consume round-trip on Postgres with numeric expiresAt", async () => {
    const { drizzle: drizzlePg } = await import("drizzle-orm/postgres-js");
    const { migrate: migratePg } = await import("drizzle-orm/postgres-js/migrator");
    const postgresMod = (await import("postgres" as string)) as {
      default: (dsn: string) => unknown;
    };
    const pgClient = postgresMod.default(PG_URL) as never;
    const db = drizzlePg(pgClient) as unknown as OmaDb;
    await migratePg(db as never, {
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    });

    const store = new DrizzleSseTicketStore(db);
    const token = `tok_pg_${Date.now()}`;
    await store.issue({
      token, tenantId: "tenant_f3_pg", userId: "user_pg",
      expiresAt: Date.now() + 30_000,
    });
    const consumed = await store.consume(token);
    expect(consumed).not.toBeNull();
    // The defense under test: PG bigint must surface as a JS number, not
    // the postgres-js string default.
    expect(typeof consumed!.expiresAt).toBe("number");
    expect(await store.consume(token)).toBeNull();
  });
});
