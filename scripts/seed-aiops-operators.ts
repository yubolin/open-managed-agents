#!/usr/bin/env tsx
// Seed the AIOps digital employees (docs/aiops-closed-loop.md §数字员工).
//
// Creates (or re-creates when --force) the alert-triage-operator agent: a
// single-purpose digital employee whose system prompt carries the AIOps
// triage protocol (kept in packages/aiops/src/signal.ts so prompt and
// envelope renderer evolve together) plus the CMP tool guidance. The agent
// is marked metadata { kind: "digital_employee", domain: "aiops" } — the
// registry's resolveCmpAgentTools() keys off exactly that.
//
// Usage:
//   BASE=http://localhost:8787 KEY=<x-api-key> scripts/seed-aiops-operators.ts
//   scripts/seed-aiops-operators.ts --name alert-triage-operator --force
//
// After seeding, enable the loop: AIOPS_ENABLED=1 (routes + tools) and
// AIOPS_DISPATCH_CRON (default every minute) in the server env.

import { AIOPS_TRIAGE_PROTOCOL_PROMPT } from "../packages/aiops/src/signal.js";

const BASE = process.env.BASE ?? "http://localhost:8787";
const KEY = process.env.KEY ?? "test-key";
const NAME = process.env.NAME ?? "alert-triage-operator";
const FORCE = process.argv.includes("--force");

const SYSTEM = [
  "你是企业 AIOps 告警分诊数字员工（alert-triage-operator），运行在 Open Managed Agents 平台上。",
  "",
  AIOPS_TRIAGE_PROTOCOL_PROMPT,
  "",
  "工作要求：",
  "- 收到告警后：解析关键字段 → 用 cmp__cmdb_lookup 定位实体与拓扑 → 查重（同一指纹已有工单则补单）→ 必要时用 cmp__itsm_ticket_create 建单 → 给出结论与处置建议。",
  "- 建议包含自动化处置时：用 cmp__automation_list 查看可用剧本，用 cmp__automation_request_approval 提请人工审批，然后结束回合等待审批结果。",
  "- 审批通过后（会收到新消息）：用 cmp__automation_execute 执行（必须携带 approval_id），随后用 cmp__itsm_ticket_append 把执行结果回写工单。",
  "- 审批被拒绝：停止该动作，将结论回写工单并收口。",
  "- 收到恢复信号：输出收口摘要并（如已有工单）追加恢复备注，可更新工单状态。",
  "- 永远不要编造 CMDB/工单/执行结果；工具失败时如实说明。",
].join("\n");

interface AgentRow {
  id: string;
  name: string;
}

async function main() {
  const headers = {
    "content-type": "application/json",
    "x-api-key": KEY,
  };
  const listRes = await fetch(`${BASE}/v1/agents`, { headers });
  if (!listRes.ok) {
    throw new Error(`list agents failed: ${listRes.status} ${await listRes.text()}`);
  }
  const existing = ((await listRes.json()) as { data?: AgentRow[] }).data?.filter(
    (a) => a.name === NAME,
  );
  if (existing?.length && !FORCE) {
    console.log(`agent "${NAME}" already exists (${existing.map((a) => a.id).join(", ")}); pass --force to create a new version anyway`);
    return;
  }

  const body = {
    name: NAME,
    description: "AIOps 告警分诊数字员工：告警 → 分析 → 建议 → 提请审批 → 执行回写",
    model: process.env.MODEL ?? "claude-sonnet-4-6",
    system: SYSTEM,
    tools: [{ type: "agent_toolset_20260401" }],
    metadata: { kind: "digital_employee", domain: "aiops" },
  };
  const res = await fetch(`${BASE}/v1/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`create agent failed: ${res.status} ${await res.text()}`);
  }
  const created = (await res.json()) as { id?: string };
  console.log(`created ${NAME}: ${created.id ?? "(id in response body)"}`);
  console.log("next: AIOPS_ENABLED=1 + restart main-node; the dispatcher will find the agent by name");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
