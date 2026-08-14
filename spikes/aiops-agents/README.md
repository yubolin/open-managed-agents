# AIOps Digital Employees — Orchestrator Sidecar

AIOps 数字员工的编排网关：**不改动 OpenMA 任何核心代码**，纯靠平台自身的
Harness 能力（Agent 配置 + Session 执行 + 公开 REST 边界）实现「值班主管 +
专家团队」的多数字人会诊，并可通过既有的飞书 Publication 接入飞书群聊。

## 架构

```
飞书群 ──WS──▶ main-node（核心，零改动）
                │ WS runner + feishu provider（既有能力）
                ▼
        aiops-duty-supervisor 的 chat-scoped Session
                │ agent.message（受理 + ```aiops-dispatch``` 派单块）
                ▼
        本 sidecar（watch 模式，纯 REST 轮询）
                │ 解析派单 → 并行专家第 1 轮 → 互评第 2 轮
                ▼
        aiops-expert-{sre,network,db,security} 的 Sessions
                │ <aiops_expert_opinions> 注入回主管 Session
                ▼
        主管输出最终结论（飞书场景由主管用 mcp__feishu__im_message_send
        发送；后续回合不会被一次性 egress 自动回显）
```

- **为什么是外置网关**：Node 版 Harness 目前没有 `call_agent_*` 原生委派、
  也没有 MCP server / custom tool 执行面（见 PRD Known Blockers）。等 Phase 0
  平台对齐落地后，本协议可原样迁到平台内实现。
- **升级隔离**：main-node、console、packages 均无任何改动；本目录与
  `scripts/seed-aiops-digital-employees.ts` 是仅有的新增面。上游合并零冲突。

## 快速开始

```bash
# 1. main-node 已运行（AUTH_DISABLED=1 或配置了 API key）
# 2. 生成 5 个数字员工 Agent
BASE=http://localhost:8787 KEY=test-key ../../scripts/seed-aiops-digital-employees.ts

# 3. 终端里跑一场完整会诊
pnpm install
pnpm ask "订单服务 5xx 飙升，DB CPU 也高了，如何定位？"
```

## 接入飞书

1. Console → Integrations → Feishu：创建 App 凭据并发布
   `aiops-duty-supervisor`（publication 状态机
   `credentials_filled → awaiting_install → live` 由既有 WS runner 驱动）。
2. 拉起本 sidecar：`pnpm watch`（轮询主管 Session 的派单块）。
3. 群内 `@机器人` 提问：受理消息自动回显；专家讨论由网关在后台进行；
   最终结论由主管调用飞书发送工具回群（chat_id 取自 `<oma_signal>` 信封）。

## 配置

复制 `.env.example` 为 `.env`：OMA 地址 / API key / Agent 名称 /
轮次上限（默认主管 3 回合）/ 单回合超时 / watch 轮询间隔。

## 协议

主管系统提示词（seed 脚本内置）要求在受理回合末尾输出：

```aiops-dispatch
{"experts": ["sre", "db"], "question": "提炼后的问题", "context": "关键背景"}
```

网关解析后执行专家两轮（首轮并行、次轮互评），并以
`<aiops_expert_opinions>` 包裹、明确署名地注入回主管 Session
（PRD FR-3：不得把 Agent 发言伪装成用户输入）。主管无派单块的回合即最终
结论；轮次耗尽时网关强制收口，讨论永不悬空。
