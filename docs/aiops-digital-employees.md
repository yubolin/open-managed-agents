# AIOps 数字员工：零核心改动的 Harness 驱动方案

**Date**: 2026-08-14
**Status**: Verified（CLI 端到端已实测通过；飞书联调待 App Secret 轮换后进行）

> 原则：**不改动 OpenMA 任何核心代码**（main-node / console / packages 零 diff），
> 完全通过平台自身的 Harness 能力（Agent 配置 + Session 执行 + 公开 REST 边界 +
> 既有飞书接入）实现「值班主管 + 专家团队」的多数字人会诊。上游升级零冲突。
>
> 配套阅读：[feishu-multi-agent-integration-prd.md](./feishu-multi-agent-integration-prd.md)
>（「单 Bot、多数字人」产品设计与 Known Blockers）、
> [feishu-session-lifecycle.md](./feishu-session-lifecycle.md)（Session 粒度决策）。

---

## TL;DR

- 5 个 AIOps 数字员工 Agent（1 值班主管 + 4 专家）通过公开 REST 种子进平台；
- `spikes/aiops-agents` 外置编排网关用文本派单协议驱动多 Session 专家会诊；
- CLI 已实测完整会诊（受理 → 派单 → 两专家两轮 → 六节最终结论），全程 71.2s；
- 飞书接入复用既有 Publication 向导 + watch 模式，无需任何平台改动。

## 1. 组件

| 组件 | 位置 | 角色 |
|---|---|---|
| 种子脚本 | `scripts/seed-aiops-digital-employees.ts` | 创建 5 个 Agent（幂等，`--force` 强制新版本） |
| 编排网关 | `spikes/aiops-agents/` | 解析派单、跑专家轮次、注入意见（`ask` 单场 / `watch` 常驻） |
| 平台能力（零改动） | main-node | `/v1/agents`、`/v1/sessions`、`/v1/sessions/:id/messages`(SSE)、飞书 WS runner + Publication 向导 |

数字员工花名册：

| Agent 名称 | 角色 |
|---|---|
| `aiops-duty-supervisor` | 值班主管：受理、派单、汇总结论 |
| `aiops-expert-sre` | SRE 专家 |
| `aiops-expert-network` | 网络专家 |
| `aiops-expert-db` | 数据库与中间件专家 |
| `aiops-expert-security` | 安全专家 |

## 2. 架构与「为什么是外置网关」

```
飞书群 ──WS──▶ main-node（零改动）
                ▼
        supervisor 的 chat-scoped Session
                │ agent.message（受理 + ```aiops-dispatch``` 派单块）
                ▼
        sidecar 网关（watch 模式，纯 REST 轮询）
                │ 解析派单 → 专家首轮并行 → 次轮互评
                ▼
        aiops-expert-* 的 Sessions（粘性复用）
                │ <aiops_expert_opinions> 署名注入回主管 Session
                ▼
        主管输出最终结论（飞书场景用 mcp__feishu__im_message_send 回群）
```

Node 版 Harness 当前能力边界（grep 验证，与 PRD Known Blockers 一致）：

- 无 `callable_agents` / `call_agent_*` 原生委派；
- 无 custom tool（`requires_action`）执行面；
- 无 MCP server 配置面（仅内置飞书工具）；
- 飞书 Bot 收不到其他 Bot 的消息 → 编排无法在群内自然发生。

因此「互相调用并对话」唯一零改动路径是：**外置网关经公开 REST 驱动多个
Session**。等 Phase 0 原生委派落地后，同一协议可原样迁入平台内实现。

## 3. 派单协议（wire protocol）

主管系统提示词要求在受理回合末尾输出：

```aiops-dispatch
{"experts": ["sre", "db"], "question": "提炼后的问题", "context": "关键背景与约束"}
```

- 网关解析后执行专家两轮：**首轮并行**（可能原因 / 需核实的指标与日志 / 初步判断）、
  **次轮互评**（补充、纠正或反驳，指出最大风险点）；
- 专家意见以 `<aiops_expert_opinions>` 包裹、按专家署名注入回主管 Session，
  并显式标注「非用户输入」（PRD FR-3：不得把 Agent 发言伪装成用户输入）；
- 主管**无派单块**的回合即最终结论（六节：问题摘要 / 主要假设 / 建议检查项 /
  风险 / 下一步行动 / 未决问题）；轮次耗尽时网关强制收口，讨论永不悬空；
- ⚠️ 种子脚本里的 `DISPATCH_PROTOCOL` 与 `spikes/aiops-agents/src/protocol.ts`
  必须保持同步。

## 4. 运行手册

### 4.1 启动平台

```bash
cd apps/main-node && AUTH_DISABLED=1 npx tsx src/index.ts   # :8787
```

> **坑**：SQLite 落盘在 **`apps/main-node/data/oma.db`**（`./data` 相对 cwd）。
> 仓库根的 `data/oma.db` 是陈旧开发库，排查「Agent/模型卡不存在」时先确认查的是哪个库。

### 4.2 前置资源（一次性）

```bash
# 1) Model Card（创建时平台会探活，ok:true 才可用）
curl -s $BASE/v1/model-cards -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{
  "model_id": "minimax-m2.7", "provider": "ant-compatible",
  "api_key": "<MINIMAX_KEY>", "base_url": "https://api.minimaxi.com/anthropic" }'

# 2) Environment（cloud agents 建会话必须带 environment_id）
curl -s $BASE/v1/environments -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name": "aiops", "config": {"type": "cloud"}}'
```

### 4.3 种子数字员工

```bash
BASE=http://localhost:8787 KEY=test-key scripts/seed-aiops-digital-employees.ts
```

### 4.4 CLI 单场会诊（已实测）

```bash
cd spikes/aiops-agents
cp .env.example .env        # 填 OMA_BASE / OMA_API_KEY / OMA_ENVIRONMENT_ID
pnpm install
pnpm ask "订单服务 5xx 飙升，DB CPU 也高了，如何定位？"
```

实测记录（2026-08-14，本地 MiniMAX M2.7）：主管受理并派单 `{sre, db}` →
两专家首轮并行 → 次轮互评 → 主管输出完整六节结论；共 3 个 Session，71.2s。

### 4.5 接入飞书

1. Console → **Integrations → Feishu**（`/integrations/feishu`）→ 发布向导，
   凭据来自飞书开放平台；发布 Agent 选 `aiops-duty-supervisor`，粒度建议
   `per_chat`（一个群一个主管 Session，与 PRD 一致）；
2. Publication 状态机 `credentials_filled → awaiting_install → live` 由既有
   WS runner 驱动，无需额外操作；
3. 群内 `@机器人` 提问 → 受理消息自动回显（一次性 egress）→ 网关在后台完成
   专家会诊 → 主管调用飞书发送工具把**最终结论**回群（`chat_id` 取自
   `<oma_signal>` 信封）；
4. 网关常驻：`pnpm watch`（轮询主管 Session 的新派单块，sha256 去重防重入）。

## 5. 已知限制与坑

1. **`/messages` SSE 边界不投递 `session.status_idle`**（实测：流在
   `span.model_request_end` 后保持打开；`packages/http-routes/src/sessions/index.ts`
   的 close 条件依赖该事件）。网关用「settle + Session 状态轮询 + 超时」混合
   终止规避，上游修复后可简化。
2. **飞书 egress 一次性回显**：每条入站消息只镜像首条 `agent.message` →
   中间会诊过程群内不可见（by design）；结论由主管主动发送（种子提示词内置
   该指令）。
3. 受理消息会带出 ` ```aiops-dispatch ` 派单块（外观瑕疵，可接受；后续可由
   网关在镜像前过滤）。
4. Agent 传 `tools: []` 平台运行时仍会挂默认 8 工具（观察到的平台行为，非缺陷）。
5. `AUTH_DISABLED=1` 仅限本地开发；生产用真实 API key + 租户。

## 6. 安全注意

- **飞书 App Secret 曾在会话中泄露，必须轮换后才能联调生产凭据**（待确认完成）；
- 模型 api_key 走 Model Card 存储，不进沙箱；网关 `.env` 已在 `.gitignore`。

## 7. 后续演进

- **Phase 0 原生委派**（`call_agent_*` 子线程模型）落地后，把派单协议迁入
  平台内实现，网关退役 — 协议与提示词无需变更；
- **AIOps 运行界面**：可基于 `/v1/sessions/:id/events` SSE 为会诊链路开发
  独立控制台（独立仓库/静态站，仍零核心改动），本阶段未启动。
