// Base E pilot seed — one short-timeout template for the live Feishu drill.
//
// Timeline baked into the seeded timeout_policy (template spec §3.2):
//   T+2min  notify_feishu_group → orange escalation card into --chat-id
//   T+5min  mark_approval_overdue_and_cancel → run.cancelled + audit
// Every fresh Run on this template is a clean drill (dedup keys are per-run).
//
// Usage:
//   pnpm --filter @open-managed-agents/main-node exec tsx \
//     scripts/seed-pilot-template.ts --chat-id oc_xxx
//   (or set OPERATIONS_PILOT_CHAT_ID; DATABASE_URL/DATABASE_PATH select the
//    store exactly like main-node boot. Requires the schema to exist — boot
//    main-node once first if the DB is fresh.)
//
// Idempotent: skips if the pilot template already exists.

import { DrizzleOperationsStore } from "@open-managed-agents/operations-store";
import {
  openPilotDb,
  PILOT_TEMPLATE_ID,
  resolvePilotTenant,
} from "./lib/pilot-db.js";

const PILOT_VERSION_ID = "stplv_pilot_v1";

function parseChatIdArg(): string | null {
  const i = process.argv.indexOf("--chat-id");
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return process.env.OPERATIONS_PILOT_CHAT_ID ?? null;
}

const chatId = parseChatIdArg();
if (!chatId) {
  console.error(
    "refusing to seed: pilot chat_id missing (pass --chat-id oc_xxx or set OPERATIONS_PILOT_CHAT_ID — the target group is embedded in the timeout policy)"
  );
  process.exit(1);
}

const tenantId = resolvePilotTenant();
const now = Date.now();

const timeoutPolicy = {
  approval_timeout_minutes: 5,
  escalation_interval_minutes: 2,
  escalation_actions: [
    { at_minute: 2, action: "notify_feishu_group", target: chatId },
    { at_minute: 5, action: "mark_approval_overdue_and_cancel", final_state_behavior: "cancelled" },
  ],
};

const db = await openPilotDb();
const store = new DrizzleOperationsStore(db);

const existing = await store.getTemplate(tenantId, PILOT_TEMPLATE_ID);
if (existing) {
  console.log(`pilot template ${PILOT_TEMPLATE_ID} already present in ${tenantId}; nothing to do`);
  process.exit(0);
}

await store.insertTemplate(
  {
    id: PILOT_TEMPLATE_ID,
    tenant_id: tenantId,
    name: "试点·审批超时演练",
    code: "pilot_timeout_drill",
    category: "diagnostic",
    description: "Base E 试点：2 分钟催办卡片 → 5 分钟按策略取消",
    is_active: 1,
    current_version_id: PILOT_VERSION_ID,
    created_by: "system_pilot_seed",
    created_at: now,
    updated_at: now,
  },
  {
    id: PILOT_VERSION_ID,
    template_id: PILOT_TEMPLATE_ID,
    tenant_id: tenantId,
    version: 1,
    is_active: 1,
    agent_binding: JSON.stringify({ agent_id: "agent_pilot_placeholder", version: 1 }),
    form_schema: JSON.stringify({
      type: "object",
      properties: { symptom: { type: "string", title: "故障现象" } },
      required: ["symptom"],
    }),
    ui_schema: null,
    approval_policy: JSON.stringify({
      mode: "sequential_groups",
      stages: [
        { stage_order: 1, stage_name: "试点审批组", group_id: "grp_sre_leads", required_approvals: 1 },
      ],
    }),
    timeout_policy: JSON.stringify(timeoutPolicy),
    changelog: "pilot v1: 2min notify + 5min cancel",
    published_by: "system_pilot_seed",
    published_at: now,
  }
);

console.log(`seeded ${PILOT_TEMPLATE_ID} (v1) in ${tenantId}`);
console.log(`  notify target : ${chatId} @ T+2min (orange interactive card)`);
console.log(`  cancel policy : T+5min (cancel_reason=approval_timeout)`);
console.log(`next: create a Run on this template and leave it in awaiting_approval`);
