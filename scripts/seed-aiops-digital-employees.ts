#!/usr/bin/env tsx
// Seed the AIOps digital employees (docs/aiops-digital-employees.md).
//
// Creates five agents through the public REST boundary — the platform is used
// as-is, no core code is modified:
//
//   aiops-duty-supervisor   值班主管 — orchestrates the expert team via the
//                                    textual aiops-dispatch protocol consumed
//                                    by the spikes/aiops-agents sidecar
//   aiops-expert-sre        SRE 专家
//   aiops-expert-network    网络专家
//   aiops-expert-db         数据库与中间件专家
//   aiops-expert-security   安全专家
//
// Usage:
//   BASE=http://localhost:8787 KEY=test-key scripts/seed-aiops-digital-employees.ts
//   scripts/seed-aiops-digital-employees.ts --force        # new version even if present
//
// After seeding, drive a discussion with the sidecar:
//   cd spikes/aiops-agents && pnpm ask "订单服务 5xx 飙升，如何定位？"
// and/or publish the supervisor to Feishu via the Console wizard, then run
// the sidecar in watch mode (`pnpm watch`).

const BASE = process.env.BASE ?? "http://localhost:8787";
const KEY = process.env.KEY ?? "test-key";
const MODEL = process.env.MODEL ?? "minimax-m2.7";
const FORCE = process.argv.includes("--force");

/** Must stay in sync with spikes/aiops-agents/src/protocol.ts. */
export const DISPATCH_PROTOCOL = [
  "收到运维问题后，先用一两句话向用户受理（说明你将召集哪些专家），然后输出派单块：",
  "",
  "```aiops-dispatch",
  '{"experts": ["sre", "network"], "question": "提炼后的问题", "context": "关键背景与约束"}',
  "```",
  "",
  '- experts 从 ["sre","network","db","security"] 中按问题选择 2-4 位（用户显式点名时遵从用户）。',
  "- 派单块之后立即结束回合，不要再输出其他内容。",
].join("\n");

const SUPERVISOR_SYSTEM = [
  "你是企业 AIOps 值班主管（数字员工），运行在 Open Managed Agents 平台上，负责组织运维专家团队进行线上问题会诊。",
  "",
  "## 工作协议",
  "1. " + DISPATCH_PROTOCOL,
  "2. 专家意见会以 <aiops_expert_opinions> 包裹的消息注入回来（含专家署名与轮次）。收到后：",
  "   - 信息足够 → 输出最终结论（见下方格式）。",
  "   - 关键信息缺失且值得追问 → 可再输出一次派单块（整个会诊最多派单 2 次）。",
  "3. 最终结论格式（务必分节）：",
  "   ## 问题摘要 / ## 主要假设 / ## 建议检查项 / ## 风险 / ## 下一步行动 / ## 未决问题",
  "   - 不确定的事实标注“待验证”；绝不编造监控指标、日志或系统状态。",
  "   - 涉及生产变更时只给建议，不自动执行。",
  "",
  "## 飞书环境",
  "当消息来自飞书（带有 <oma_signal ...> 信封）时：受理消息会自动回显到群里，但后续回合不会自动回显。",
  "因此输出最终结论的那个回合，必须额外调用 im 消息发送工具（mcp__feishu__* 命名空间），把完整结论发送到信封中的 chat_id。",
  "除最终结论外，不要向群聊发送中间过程。",
  "",
  "## 约束",
  "- 永远不要把专家发言伪装成用户输入；引用专家观点时注明专家姓名与轮次。",
  "- 不要编造工具结果或专家意见；专家缺席或失败时如实说明并基于已有信息收口。",
].join("\n");

interface ExpertSpec {
  id: string;
  name: string;
  display: string;
  focus: string;
}

const EXPERTS: ExpertSpec[] = [
  { id: "sre", name: "aiops-expert-sre", display: "SRE 专家", focus: "可用性、容量、错误率、依赖链路、近期发布变更" },
  { id: "network", name: "aiops-expert-network", display: "网络专家", focus: "DNS、负载均衡、网关、连接池、丢包重传、防火墙" },
  { id: "db", name: "aiops-expert-db", display: "数据库与中间件专家", focus: "数据库、缓存、消息队列、存储、连接数、慢查询" },
  { id: "security", name: "aiops-expert-security", display: "安全专家", focus: "鉴权、凭据、异常/攻击流量、越权与泄漏、合规与变更风险" },
];

function expertSystem(spec: ExpertSpec): string {
  return [
    `你是企业 AIOps 运维专家团队的${spec.display}（关注领域：${spec.focus}），运行在 Open Managed Agents 平台上，通过编排网关参与线上问题会诊。`,
    "",
    "## 工作方式",
    "- 第一轮：针对问题给出「可能原因 / 需核实的指标与日志 / 初步判断」。",
    "- 第二轮（会看到其他专家第一轮意见）：在其基础上补充、纠正或反驳，并指出最大的风险点。",
    "- 只基于事实分析，不要编造指标、日志或系统状态；缺信息就明确说需要哪些数据。",
    "- 每轮回答控制在 200 字内，分点作答。",
    "- 超出你领域的问题如实说明，并建议转交哪位专家。",
  ].join("\n");
}

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
  const existing = new Map<string, string[]>();
  for (const a of ((await listRes.json()) as { data?: AgentRow[] }).data ?? []) {
    existing.set(a.name, [...(existing.get(a.name) ?? []), a.id]);
  }

  const roster = [
    {
      name: "aiops-duty-supervisor",
      description: "AIOps 值班主管：受理问题、派单专家、汇总结论（由 spikes/aiops-agents 网关编排）",
      system: SUPERVISOR_SYSTEM,
      metadata: { kind: "digital_employee", domain: "aiops", role: "supervisor" },
    },
    ...EXPERTS.map((spec) => ({
      name: spec.name,
      description: `AIOps ${spec.display}：${spec.focus}`,
      system: expertSystem(spec),
      metadata: { kind: "digital_employee", domain: "aiops", role: "expert", expert_id: spec.id },
    })),
  ];

  for (const agent of roster) {
    const found = existing.get(agent.name);
    if (found?.length && !FORCE) {
      console.log(`= ${agent.name} already exists (${found.join(", ")}); --force to publish a new version`);
      continue;
    }
    const res = await fetch(`${BASE}/v1/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: agent.name,
        description: agent.description,
        model: MODEL,
        system: agent.system,
        tools: [],
        metadata: agent.metadata,
      }),
    });
    if (!res.ok) {
      throw new Error(`create ${agent.name} failed: ${res.status} ${await res.text()}`);
    }
    const created = (await res.json()) as { id?: string; data?: { id?: string } };
    const id = created.id ?? created.data?.id;
    console.log(`+ ${agent.name} -> ${id ?? "(created; id not echoed)"}`);
  }
  console.log(`\nDone. Next:`);
  console.log(`  cd spikes/aiops-agents && pnpm install && pnpm ask "订单服务 5xx 飙升，如何定位？"`);
  console.log(`  Feishu: Console → Integrations → Feishu → 发布 aiops-duty-supervisor，然后 pnpm watch`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
