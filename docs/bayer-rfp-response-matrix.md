# Bayer VOPs AIOps RfP — 需求逐条响应表

> 响应基线：OpenMA 当前架构（repo @ 8027dde + GitHub PR #157 飞书集成）。
> 评级：✅ 开箱即用 ／ 🟡 原语具备、交付层补齐 ／ ⚠️ Phase 3 新建。
> 阶段归属：P2 = Concept & Design 产出设计；P3 = Implementation 建成；「配置」= 智能体/skills 作者工作，无平台改动。
> 范围声明：RfP 明确 CMP 本体 out of scope；本响应覆盖 **UI + AIOps** 及其与 CMP API（ITSM/CMDB/Automation/Operational Data）的集成面。

---

## A. Functional Requirements（6 条 shall）

| # | RfP 原文（摘录） | 满足度 | 当前架构证据 | 缺口与归属 |
|---|---|---|---|---|
| F1 | "…unified lifecycle management, including provisioning, modification, and decommissioning, across AWS, Azure, and Alibaba Cloud…" | ⚠️ | 平台无云内置模块；Executor 原语就绪：sandbox（local-runtime）可跑 IaC/CLI，vault `command_secret` 经出站代理注入三云凭据（明文永不进沙箱） | 三云 Executor 工具集与场景流 = P3 |
| F2 | "…automated cloud account onboarding and baseline initialization with built-in governance controls." | ⚠️ | onboarding = 编排化 Executor 流；governance baseline = Policy-as-Code 输入（见 S4） | 基线策略库 + 审批闸联动 = P2 设计 / P3 建成 |
| F3 | "…automated Day-2 operations, including patching, script execution, application deployment, and routine maintenance…" | 🟡 | sandbox bash + environments 包管理（apt/pip/npm/cargo/gem/go）+ 网络白名单；custom tool `permission_policy: always_ask` 管高风险操作 | 补丁/部署 runbooks 与幂等/回滚规范 = 配置 + P3 |
| F4 | "…integrate seamlessly with enterprise ITSM systems to support ticket-driven operations and workflow automation." | 🟡 | integrations-core provider 模型已有 4 实现（Linear/GitHub/Slack/Feishu），webhook/WS 事件驱动、per-thread session scope、工单式闭环（Linear）实测 | ServiceNow/企业 ITSM 连接器 + 单号闭环 = P2 契约 / P3 建成 |
| F5 | "…AI-native architecture leveraging multi-agent frameworks, retrieval-augmented generation, and tool- or skill-based execution…" | ✅ | 多智能体：`callable_agents` → 派生 `call_agent_*`；工具/技能：8 工具 toolset + skills 挂载 + MCP；RAG：memory store/skills 文件级知识 + grep + aux 摘要（向量检索 P2/P3 扩展） | 向量 RAG 为增强项，非阻塞 |
| F6 | "…alert ingestion, intelligent analysis, and automated remediation … closed-loop AIOps." | 🟡 | 分析闭环实测（告警→supervisor 派单→专家两轮会诊→结论回写，事件日志可审计）；`aiops_alerts` 为规划中领域模型，尚无代码实体（roadmap §2.3）；归一化设计文档在 | 接入 webhook 与 remediation 执行（经审批闸）= P3 |

## B. Required Skillsets（11 项能力）

| # | RfP 能力（摘录） | 满足度 | 当前架构证据 | 缺口与归属 |
|---|---|---|---|---|
| S1 | Multi-Agent architecture with task orchestration（意图识别、handoff、顺序/并行/条件/回滚、状态机、重试/超时/恢复、人工干预点） | 🟡 | supervisor–experts 实测：意图识别（LLM 派单块）、并行会诊、交叉复核、人工可中断（`user.interrupt`）；session 崩溃自动恢复（事件先落库后广播） | 编排器产品化：显式状态机/回滚/超时重试 = P3（现 spike sidecar 升级） |
| S2 | Inter-agent communication, role definition, shared context（Planner/Validator/Executor/Approver/Auditor 角色绑定 tools/skills） | ✅ | 角色 = 版本化 agent 配置（model/system/tools/skills/mcp）；共享上下文 = memory store 挂载 `/mnt/memory/<store>/` + append-only 事件日志 + metadata 交接 | — |
| S3 | Scenario Planner Agents → 可执行 Context+Plan（JSON/YAML，四场景） | 🟡 | 结构化输出约束：system + `aux_model` + custom tool `input_schema`；实测 dispatch JSON 块被下游直接消费 | 四场景 Planner 作者工作 = 配置 |
| S4 | Validate Agent with Policy as Code + 冲突仲裁 + human fallback | ⚠️ | HITL 原语在（custom tool `requires_action` + `always_ask`）；sandbox 可运行 OPA/策略脚本 | 策略引擎、优先级/升级规则、仲裁 = P2 设计 / P3 建成 |
| S5 | Approval Agent with HITL（风险分级：低危策略自批、高危强制人工，Assign to Ops + AI Recommendation） | 🟡 | 审批服务为待新建能力（③），ADR 处于记录草案阶段；范围与验收见 roadmap §4；现有确认面板仅提供 HITL 原语 | 审批服务按 roadmap §4 新建 = P1 |
| S6 | Executor Agents（Cloud APIs、IaC、脚本、流水线；结构化结果、幂等、回滚） | ✅ | sandbox 执行层 + vault 出站代理凭据注入（`static_bearer`/`command_secret`）+ MCP；结构化结果 = 工具返回契约 | 幂等/回滚 runbook 规范 = 配置 + P3 |
| S7 | Event-driven orchestration with ITSM closed-loop（webhook 建单、审批同步、结果回写 Completed/Failed、单号闭环） | 🟡 | 事件驱动实测：Feishu `im.message.receive_v1` → session → 结论回写；Linear issue 流同模式 | ITSM 事件→建单→回写闭环 = P3（契约 P2） |
| S8 | MCP & Tool Calling / OpenAPI（参数校验、权限控制、调用审计） | ✅ | per-agent `mcp_servers` + 派生 `mcp_*` 工具 + vault `mcp_oauth` 刷新注入 + MCP proxy；custom tool JSON Schema 校验；`agent.mcp_tool_use/result` 全审计 | — |
| S9 | Enterprise security, identity, RBAC/ABAC, least privilege + 端到端可观测/审计/可解释 | 🟡 | packages/auth + 租户隔离 + API key；vault 最小权限；append-only 事件日志 = who/which tool/I/O 全链路；`span.model_request_*` 可观测（packages/observability）；agent.thinking 可解释 | OIDC/SSO 接入、squad 级 RBAC/ABAC 映射 = P2 设计 / P3 建成 |
| S10 | RAG + LLM Guardrails + 持续优化 + Shadow Mode 试点（runbook/SOP/历史工单 RAG；schema 约束抑幻觉；Auditor 反馈环；accuracy/intervention rate/MTTR） | 🟡 | 文件级 RAG（memory store/skills + grep + aux 摘要）；schema 约束（tool input_schema）；evals 框架（eval-core/evals-runner + GAIA）+ RL 管线（rl/ veRL GRPO）持续优化 | 向量检索、Shadow Mode 编排、MTTR/干预率仪表盘 = P2 设计 / P3 建成 |

## C. VOPs UI（in scope）

| RfP 原文（摘录） | 满足度 | 当前架构证据 | 缺口与归属 |
|---|---|---|---|
| "A web-based interface with chat and form-based interactions…" | ✅ | apps/console（React）：会话聊天、事件 timeline、工具确认/审批面板（表单交互）、智能体与集成管理 | 拜耳品牌与 CMP 入口定制 = P3 |

---

## D. 汇总与投标要点

- **计数**：✅ 5 ／ 🟡 9 ／ ⚠️ 3。架构方向无根本性冲突，但存在领域级能力缺位的系统性缺口，超出普通交付集成缺口范畴；部分条目有前置资产，知识服务、审批、工作流状态机、策略门、AIOps 领域模型均为待新建（③）。
- **平台同构性**（可作为「平台能力矩阵」直接入标）：RfP 所述内部 Agentic AI 平台清单 ↔ OpenMA：Agentic SDK = `packages/sdk`；LLM gateway = model cards（自定义 provider/base_url、密钥加密 at-rest）；agent-to-agent = `callable_agents`；scheduling/CLI = `packages/scheduler` + `packages/cli`；MCP/orchestrator 模板 = skills + 派生工具。
- **差异化安全卖点**：① 凭据永不进沙箱的出站代理注入（三云 Executor 凭据安全）；② append-only 事件日志天然满足「who decided / why / which tool / I/O」审计与可解释性；③ 双运行时（CF / Node 自托管 docker-compose，SQLite/Postgres）满足中国 IT landscape 数据驻留，不依赖境外 SaaS。
- **Assumptions（建议在标书中披露）**：CMP 本体 out of scope（RfP 自述）；审批服务为待新建能力，CMP 连接器按 roadmap 推进；编排器现以外部 sidecar（spikes/aiops-agents）验证，P3 产品化入平台；Knowledge Service（含向量检索）前移至 P1，指标仪表盘为 P3 增强项。
- **阶段映射**：P1 = 项目计划/RACI/kickoff（流程交付物）；P2 = 策略引擎、ITSM 契约、SSO/RBAC、RAG 架构、指标体系的详细设计；P3 = 上述 🟡/⚠️ 项建成 + UAT/培训/迁移/hypercare/文档（对应 RfP Phase 3 交付物清单）。
