// CF scheduler wiring — registers the CF cron handlers via the
// runtime-agnostic Scheduler interface. Each handler is the same one
// registered by Node in apps/main-node/src/lib/node-scheduler-jobs.ts.
//
// CF still owns the schedule itself (wrangler `triggers.crons`). The
// scheduled() entry below calls `dispatch(controller.cron)` to look up
// and invoke registered jobs whose cron expression matches.

import type { Env } from "@open-managed-agents/shared";
import { log, logError, recordEvent, errFields } from "@open-managed-agents/shared";
import { forEachShardServices } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { createCfScheduler, type CfScheduler } from "@open-managed-agents/scheduler/cf";
import { memoryRetentionTick } from "@open-managed-agents/scheduler/jobs/memory-retention";
import { webhookEventsRetentionTick } from "@open-managed-agents/scheduler/jobs/webhook-events-retention";
import {
  runOperationsTimeoutTick,
  type SendEscalationCard,
  type TimeoutTickStats,
} from "@open-managed-agents/operations-store";
import { FeishuApiClient } from "@open-managed-agents/feishu";
import { WorkerHttpClient } from "@open-managed-agents/integrations-adapters-cf";
import { tickEvalRuns } from "../eval-runner";
import { dreamRecoveryTick } from "../cron/dream-recovery";

// Cron expressions are env-overridable so ops can shift sweeps without a
// code deploy. Defaults match the pre-extract behaviour exactly.
function envCron(env: Env, key: string, fallback: string): string {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  return raw && raw.trim() ? raw : fallback;
}

/** Escalation-card egress — bootstrap-tier env creds, identical degradation
 *  semantics to main-node: without creds the sender throws per action, the
 *  tick records delivered:false and the cancel path still runs. */
function buildOperationsCardSender(env: Env): SendEscalationCard {
  const appId = env.OPERATIONS_FEISHU_APP_ID;
  const appSecret = env.OPERATIONS_FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    return async () => {
      throw new Error(
        "OPERATIONS_FEISHU_APP_ID/SECRET not configured (card egress disabled)",
      );
    };
  }
  const client = new FeishuApiClient({ appId, appSecret }, new WorkerHttpClient());
  return async (chatId, card) => {
    await client.sendCard({ chatId, card });
  };
}

export function buildCfScheduler(env: Env): CfScheduler {
  const scheduler = createCfScheduler();
  const tickCron = envCron(env, "EVAL_TICK_CRON", "* * * * *");
  const memoryCron = envCron(env, "MEMORY_RETENTION_CRON", "* * * * *");
  const webhookCron = envCron(env, "WEBHOOK_EVENTS_RETENTION_CRON", "* * * * *");
  const dreamsCron = envCron(env, "DREAM_RECOVERY_CRON", "* * * * *");
  const operationsTimeoutCron = envCron(env, "OPERATIONS_TIMEOUT_CRON", "* * * * *");

  scheduler.register({
    name: "eval-tick",
    cron: tickCron,
    handler: () =>
      tickEvalRuns(env).then(
        (result) =>
          log(
            { op: "cron.tick_eval_runs", advanced: result.advanced, total: result.total },
            "tickEvalRuns ok",
          ),
        (err) => {
          logError({ op: "cron.tick_eval_runs", err }, "tickEvalRuns failed");
          recordEvent(env.ANALYTICS, {
            op: "cron.tick_eval_runs.failed",
            ...errFields(err),
          });
        },
      ),
  });

  scheduler.register({
    name: "memory-retention",
    cron: memoryCron,
    handler: memoryRetentionTick({
      forEachShard: (fn) => forEachShardServices(env, (s, name) => fn(s, name)),
    }),
  });

  scheduler.register({
    name: "webhook-events-retention",
    cron: webhookCron,
    handler: webhookEventsRetentionTick({
      resolveIntegrationsDb: () =>
        env.INTEGRATIONS_DB ? new CfD1SqlClient(env.INTEGRATIONS_DB) : null,
    }),
  });

  scheduler.register({
    name: "dream-recovery",
    cron: dreamsCron,
    handler: () => dreamRecoveryTick(env),
  });

  // F3 P3-③ · operations approval-timeout sweep. The scan-and-act logic is
  // the SAME shared runOperationsTimeoutTick the Node interval runs — only
  // the firing mechanism differs. CF Cron Triggers fire this handler once
  // per scheduled event per worker, so cross-replica dedup comes free; even
  // an overlapping tick is safe (run_events dedup markers + cancelRun CAS).
  const operationsCardSender = buildOperationsCardSender(env);
  scheduler.register({
    name: "operations-timeout",
    cron: operationsTimeoutCron,
    handler: async () => {
      let perShard: TimeoutTickStats[];
      try {
        const results = await forEachShardServices(env, async (services) => {
          // A shard predating the operations migration (0003) must not kill
          // the sweep — soft-skip it, same as an unbound shard binding.
          try {
            return await runOperationsTimeoutTick({
              service: services.operations,
              sendCard: operationsCardSender,
              workspaceBaseUrl: env.OPERATIONS_WORKSPACE_BASE_URL,
            });
          } catch (err) {
            logError(
              { op: "cron.operations_timeout.shard_failed", err },
              "operations timeout tick failed for a shard; skipping it",
            );
            return null;
          }
        });
        perShard = results.filter((r): r is TimeoutTickStats => r !== null);
      } catch (err) {
        // Shard registry unreadable — a control-plane hiccup must not crash
        // the cron; the next tick retries.
        logError(
          { op: "cron.operations_timeout.registry_failed", err },
          "operations timeout tick could not enumerate shards",
        );
        recordEvent(env.ANALYTICS, {
          op: "cron.operations_timeout.registry_failed",
          ...errFields(err),
        });
        return;
      }
      const totals = perShard.reduce<TimeoutTickStats>(
        (acc, s) => ({
          scanned: acc.scanned + s.scanned,
          notified: acc.notified + s.notified,
          cancelled: acc.cancelled + s.cancelled,
          skipped: acc.skipped + s.skipped,
          errors: acc.errors + s.errors,
        }),
        { scanned: 0, notified: 0, cancelled: 0, skipped: 0, errors: 0 },
      );
      log(
        { op: "cron.operations_timeout", ...totals, shards: perShard.length },
        "operations timeout tick ok",
      );
    },
  });

  return scheduler;
}
