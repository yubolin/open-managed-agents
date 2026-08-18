# Base E 试点 Runbook · 审批超时 × 飞书卡片全链路联调

> 目标：在真实飞书群里验证 `notify_feishu_group` 橙色催办卡片与
> `mark_approval_overdue_and_cancel` 按策略取消——这两条路径至今只有
> fake-Feishu 测试覆盖（`sendCard` 的卡片 JSON 与 `/im/v1/messages` 直发
> 均为仓内首例，从未打过真实 API）。试点 = 上线前的事实核验，不是演示。

## 0. 前置条件（缺一不可）

| # | 条件 | 说明 |
|---|------|------|
| 1 | `OPERATIONS_FEISHU_APP_ID` / `OPERATIONS_FEISHU_APP_SECRET` | bootstrap 层凭证（`.env.example` 尾部有样例）。注意：卡片出口**不走** vault / pubs 表——chat↔App 自动路由尚不存在（债 E-N1） |
| 2 | 目标群 `oc_` chat_id，且上述 App 的机器人**已入群**并有发消息权限 | 群设置 → 群机器人 → 添加该 App；chat_id 可从群信息或机器人 Webhook 调试获取 |
| 3 | main-node 正常启动一次（迁移已应用） | `DATABASE_URL`（PG）或默认 `./data/oma.db`（sqlite）均可，试点脚本与 main-node 必须指向**同一个库** |
| 4 | （可选）`OPERATIONS_WORKSPACE_BASE_URL` | 卡片深链前缀，默认 `http://localhost:5175`（operations SPA）。生产域名接入时改这里 |
| 5 | （可选）SPA 起着 | `pnpm --filter @open-managed-agents/operations dev` —— SSE 实时帧与深链落地页。不起也行，curl 全程可验 |

## 1. 环境准备

```bash
# .env（或进程环境）
export OPERATIONS_FEISHU_APP_ID=cli_xxxx
export OPERATIONS_FEISHU_APP_SECRET=xxxx
export OPERATIONS_PILOT_CHAT_ID=oc_xxxx   # 目标群
# export DATABASE_URL=postgres://...      # 与 main-node 同库！
```

## 2. 播种试点模板（幂等，重复跑安全）

```bash
pnpm --filter @open-managed-agents/main-node exec tsx \
  scripts/seed-pilot-template.ts --chat-id oc_xxxx
```

产出模板 `stpl_pilot_timeout`（tenant_default，单审批组 grp_sre_leads），
timeout_policy 时间线**写死**为：

| 时刻 | 动作 | 预期产物 |
|------|------|----------|
| T+2min | `notify_feishu_group` | 群内橙色 interactive 卡片（标题 ⏰ 审批超时催办，主按钮深链 run 详情） |
| T+5min | `mark_approval_overdue_and_cancel` | run → `cancelled`（cancel_reason=approval_timeout），`run.cancel` 审计 + `run.cancelled` SSE 帧 |

> T0 = run 进入 `awaiting_approval` 时刻（锚点 `runs.updated_at`）。
> 调度器 tick ≤60s，事件实际到达时刻有至多一个 tick 的滞后，属正常。

## 3. 造一发演练 run

```bash
# 前提：main-node 已在本库上运行（调度器随进程常驻，默认开启）
pnpm --filter @open-managed-agents/main-node exec tsx \
  scripts/pilot-drill-run.ts --title "试点-第一发"
```

脚本经 OperationsService 走真 CAS 链：create → submit → planning →
`awaiting_approval`（planning 转移是 service 内部路径，BFF 无此路由——
生产由 agent runner 驱动，试点由脚本代打）。输出 run_id 与 T0。

**每造一发新 run 就是一次干净演练**——超时去重键（`<action>:<at_minute>`）
按 run 生命周期计，不跨 run 复用。

## 4. 观测点

| 通道 | 命令 / 位置 | 看什么 |
|------|-------------|--------|
| 群 | 目标飞书群 | T+2min 橙卡；点主按钮应深链到 `${BASE_URL}/runs/:id` |
| REST | `curl -H "x-tenant-id: tenant_default" localhost:8787/v1/workspace/runs/<id>` | T+5min 后 `state: "cancelled"` |
| SSE | SPA run 详情页（或 `curl -N` stream + ticket） | `run.escalation`（T+2）与 `run.cancelled`（T+5）帧 |
| 审计 | `run_events` 表 `action IN ('run.escalation','run.cancel')` | dedup_key、`payload.delivered`（卡片是否真发成功） |

## 5. 排障

| 症状 | 定位 |
|------|------|
| 无卡片，`delivered:false` | 凭证缺失（main-node 启动日志 "not configured"）或 App Secret 无效——卡片失败**不阻断**取消链路，T+5 仍会取消 |
| 卡片 API 报错 | main-node 日志 `timeout_scheduler.action_failed`：看 Feishu 错误码（99991672 = 机器人不在群；19021 = chat_id 不存在） |
| T+5 未取消 | 先确认 run 仍 `awaiting_approval`（被人批掉则 CAS 人赢——属预期）；再看 `OPERATIONS_TIMEOUT_SCHEDULER` 是否被置 0 |
| 卡片到了但深链 404 | SPA 没起或 `OPERATIONS_WORKSPACE_BASE_URL` 指错 |
| 想缩短 tick 加速演练 | `OPERATIONS_TIMEOUT_INTERVAL_MS=15000` 重启 main-node |

## 6. 收尾

- 演练 run 自终态（cancelled），无需清理；模板 `stpl_pilot_timeout`
  可留作回归（`is_active:1`，不进生产目录无副作用），要拆就删
  `service_templates`/`service_template_versions` 两行。
- 凭证撤收：试点结束后轮换 App Secret（bootstrap 层凭证进过测试环境）。

## 7. 已知边界（如实告知，不装看不见）

- **卡片 JSON 首打真实 API**：字段结构对齐飞书 interactive card 文档，
  但若真实渲染有出入（如 lark_md 语法差异），修 `buildEscalationCard`
  即可，不动调度器语义。
- **多副本**：main-node 起多实例时调度器每副本各跑一份 → 卡片重发。
  试点单实例无此问题；生产解法（PG advisory lock / leader election）
  已列 P1（评审观测 2）。
- **notify_process_owner 未试点**：F7（缺 user↔open_id 目录），试点模板
  不含该动作。
