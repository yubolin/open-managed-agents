// Watch mode entry — pairs with the Feishu publication of the supervisor.
//
//   pnpm watch

import { loadConfig } from "./env.js";
import { OmaClient } from "./oma.js";
import { Orchestrator, type ExpertRole, type ExpertId } from "./orchestrator.js";
import { startWatcher } from "./watch.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const oma = new OmaClient({
    baseUrl: config.omaBase,
    apiKey: config.omaApiKey,
    timeoutMs: config.turnTimeoutMs,
    environmentId: config.omaEnvironmentId,
  });

  const supervisorAgentId = await oma.requireAgent(config.supervisorName);
  const expertEntries = Object.entries(config.expertNames) as Array<[ExpertId, string]>;
  const experts: ExpertRole[] = [];
  for (const [id, name] of expertEntries) {
    experts.push({
      id,
      label: { sre: "SRE 专家", network: "网络专家", db: "数据库与中间件专家", security: "安全专家" }[id],
      agentId: await oma.requireAgent(name),
    });
  }

  const orchestrator = new Orchestrator(oma, {
    supervisorAgentId,
    experts,
    maxSupervisorTurns: config.supervisorMaxTurns,
  });

  const watcher = startWatcher({ oma, config, supervisorAgentId, orchestrator });
  console.log("aiops-agents sidecar watching — Ctrl+C to stop");

  const shutdown = () => {
    console.log("\nstopping…");
    watcher.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
