// CLI: one-shot discussion from the terminal — the fastest way to exercise
// the full supervisor → experts → conclusion loop without Feishu.
//
//   pnpm ask "订单服务 5xx 飙升，DB CPU 也高了，如何定位？"

import { loadConfig } from "./env.js";
import { OmaClient } from "./oma.js";
import { Orchestrator, type ExpertRole, type ExpertId } from "./orchestrator.js";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error('usage: pnpm ask "运维问题"');
    process.exit(2);
  }

  const config = loadConfig();
  const oma = new OmaClient({
    baseUrl: config.omaBase,
    apiKey: config.omaApiKey,
    timeoutMs: config.turnTimeoutMs,
    environmentId: config.omaEnvironmentId,
  });

  console.log(`${DIM}resolving agents on ${config.omaBase}…${RESET}`);
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
    onProgress: (line) => console.log(`${DIM}${line}${RESET}`),
  });

  const started = Date.now();
  const result = await orchestrator.run(question);

  console.log(`\n${BOLD}── 会诊过程 ──${RESET}`);
  for (const entry of result.transcript) {
    const color = entry.kind === "supervisor" ? CYAN : entry.kind === "expert" ? YELLOW : DIM;
    console.log(`\n${color}${BOLD}【${entry.speaker}】${RESET}`);
    console.log(entry.text);
  }

  console.log(`\n${BOLD}${GREEN}── 最终结论 ──${RESET}`);
  console.log(result.conclusion);
  console.log(
    `\n${DIM}supervisor session ${result.supervisorSessionId} · ${Object.keys(result.expertSessionIds).length} expert sessions · ${((Date.now() - started) / 1000).toFixed(1)}s${RESET}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
