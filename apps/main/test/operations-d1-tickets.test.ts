// F3 P2-① — real-D1 proof of the cross-isolate SSE ticket truth.
//
// Runs under the ROOT vitest config (pool-workers / workerd); apps/main is
// NOT in that config's exclude list, so this file is discovered by plain
// `vitest run`. pool-workers does NOT auto-apply migrations_dir (that is a
// wrangler-deploy-time behavior), so the sse_tickets schema is applied
// EXPLICITLY: the migration SQL is inlined via Vite's ?raw import (a build-
// time string — no fs inside workerd) and exec'd idempotently in beforeAll.
//
// "Cross-isolate" here = two INDEPENDENT store instances over the same
// physical D1 (exactly what two worker isolates each construct via
// createCfSseTicketStore(env.MAIN_DB)). Single-use is D1-atomic
// (DELETE ... RETURNING): exactly one contender wins.

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { createCfSseTicketStore } from "@open-managed-agents/operations-store";
// Drizzle-generated D1 migration for sse_tickets (0003_wandering_martin_li).
// The `--> statement-breakpoint` markers are SQL comments — exec-safe.
import migrationSql from "../migrations/0003_wandering_martin_li.sql?raw";

const d1 = env.MAIN_DB as unknown as D1Database;

beforeAll(async () => {
  // D1 exec() chokes on statements with embedded newlines (splits on line
  // boundaries) — collapse each statement onto one line and exec them
  // individually, split on drizzle's statement-breakpoint markers.
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const stmt of statements) await d1.exec(stmt);
});

describe("SseTicketStore · real D1 (workerd)", () => {
  it("d1-1: two instances over one D1 share single-use truth exclusively", async () => {
    const replicaA = createCfSseTicketStore(d1);
    const replicaB = createCfSseTicketStore(d1);

    const token = `tok_d1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await replicaA.issue({
      token,
      tenantId: "tenant_d1",
      userId: "user_d1",
      runId: "run_d1",
      expiresAt: Date.now() + 30_000,
    });

    const consumed = await replicaB.consume(token);
    expect(consumed).not.toBeNull();
    expect(consumed).toMatchObject({
      tenantId: "tenant_d1",
      userId: "user_d1",
      runId: "run_d1",
    });
    // Numeric expiresAt — the row-mapping boundary defense.
    expect(typeof consumed!.expiresAt).toBe("number");

    // Spent on the shared truth: even the minting instance loses.
    expect(await replicaA.consume(token)).toBeNull();
    expect(await replicaB.consume(token)).toBeNull();
  });

  it("d1-2: sweepExpired reaps never-redeemed tickets only", async () => {
    const store = createCfSseTicketStore(d1);
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const T = Date.now();

    await store.issue({
      token: `tok_d1_live_${suffix}`,
      tenantId: "tenant_d1",
      userId: "user_d1",
      expiresAt: T + 60_000,
    });
    await store.issue({
      token: `tok_d1_dead_${suffix}`,
      tenantId: "tenant_d1",
      userId: "user_d1",
      expiresAt: T - 60_000,
    });

    const swept = await store.sweepExpired(T);
    // Global sweep on a shared test DB: AT LEAST our dead ticket reaped.
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await store.consume(`tok_d1_dead_${suffix}`)).toBeNull();
    expect(await store.consume(`tok_d1_live_${suffix}`)).not.toBeNull();
  });
});
