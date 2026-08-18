// F3 P3-③ — operations-timeout job registration smoke (workerd).
//
// The scan-and-act LOGIC is proven by the main-node suite against a real
// OperationsService (same shared runOperationsTimeoutTick — extraction means
// one test surface, not two). This file proves the CF wiring: the job is
// registered with the env-overridable cron, and its handler walks the shard
// enumeration without throwing — shards predating migration 0003 are
// soft-skipped, an unreadable shard registry degrades to a logged no-op.

import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { buildCfScheduler } from "../src/lib/cf-scheduler-jobs";

describe("CF scheduler · operations-timeout job (workerd)", () => {
  it("sched-1: registers operations-timeout with the default every-minute cron", () => {
    const scheduler = buildCfScheduler(env);
    const job = scheduler.list().find((j) => j.name === "operations-timeout");
    expect(job).toBeDefined();
    expect(job!.cron).toBe("* * * * *");
  });

  // NOTE: no scheduler.dispatch() test on purpose — the shared every-minute
  // cron would sequentially fire every other job (eval/dreams/retention)
  // and an unrelated failure would masquerade as ours. The handler is
  // invoked DIRECTLY instead.

  it("sched-2: handler completes over a live shard even without operations tables (soft-skip)", async () => {
    // Warm the test worker's migration bootstrap (ensureMigrations seeds the
    // shard registry with MAIN_DB) so forEachShardServices enumerates a real
    // shard. MAIN_DB lacks the operations tables here — the per-shard catch
    // must soft-skip it and the handler must still settle with zero totals.
    await SELF.fetch("https://example.com/");

    const scheduler = buildCfScheduler(env);
    const job = scheduler.list().find((j) => j.name === "operations-timeout");
    expect(job).toBeDefined();
    // Direct handler invocation: no-throw IS the contract (outcomes logged).
    await expect(job!.handler()).resolves.toBeUndefined();
  });
});
