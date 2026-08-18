// Base E pilot drill — drive ONE run into awaiting_approval on the pilot
// template, then hand it to the main-node timeout scheduler.
//
// Division of labor (this is the ONLY way a run reaches awaiting_approval
// today: planning transitions are service-internal, BFF has no planning
// routes — the agent runner would normally drive them):
//   THIS script   : create → submit → planning → awaiting_approval (via
//                   OperationsService, same CAS/audit path as production)
//   main-node proc: timeout scheduler picks the run up on its next tick
//                   (listAwaitingApprovalRunsSystem reads the shared DB),
//                   sends the T+2min card, cancels at T+5min, and broadcasts
//                   run.escalation / run.cancelled on ITS hub — so the SPA
//                   SSE stream (mounted on main-node) sees every frame.
//
// Usage (DB must already be seeded — run seed-pilot-template.ts first and
// keep main-node RUNNING while the drill plays out):
//   pnpm --filter @open-managed-agents/main-node exec tsx \
//     scripts/pilot-drill-run.ts --title "试点-第一发"

import { createHash } from "node:crypto";
import { DrizzleOperationsStore } from "@open-managed-agents/operations-store";
import { OperationsService } from "@open-managed-agents/operations-store";
import { openPilotDb, PILOT_TEMPLATE_ID, resolvePilotTenant } from "./lib/pilot-db.js";

function parseTitleArg(): string {
  const i = process.argv.indexOf("--title");
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return "试点·审批超时演练";
}

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

const tenantId = resolvePilotTenant();
const title = parseTitleArg();
const actor = { type: "user" as const, id: "user_pilot_operator", name: "Pilot Operator" };

const db = await openPilotDb();
const store = new DrizzleOperationsStore(db);
const service = new OperationsService(store);

const run = await service.createRun({
  tenantId,
  templateId: PILOT_TEMPLATE_ID,
  title,
  inputParameters: { symptom: "试点演练：审批超时卡片链路" },
  actor,
  autoSubmit: true,
});
console.log(`run ${run.id} created (submitted)`);

await service.startPlanning(tenantId, run.id, `sess_pilot_${run.id}`, actor);
console.log(`run ${run.id} → planning`);

const planContent = JSON.stringify({
  summary: "试点演练计划：等待审批超时，验证催办卡片与按策略取消",
  steps: ["进入 awaiting_approval", "T+2min 期待橙色催办卡片", "T+5min 期待系统取消"],
});
const finalRun = await service.finishPlanning(
  tenantId,
  run.id,
  { content: planContent, sha256: sha256(planContent) },
  {
    id: `art_ev_pilot_${run.id}`,
    content: "试点演练证据：本 run 由 pilot-drill-run.ts 生成",
    sha256: sha256(`art_ev_pilot_${run.id}`),
  },
  actor,
);
console.log(`run ${run.id} → ${finalRun.state}`);
console.log(`clock started at updated_at=${new Date(finalRun.updated_at).toISOString()}`);
console.log(`expect: T+2min card → T+5min cancelled (scheduler in main-node, tick ≤60s)`);
console.log(`watch : GET /v1/workspace/runs/${run.id}  (x-tenant-id: ${tenantId})`);
