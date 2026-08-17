# AIOps 数字员工平台 · 复用矩阵与实施路线

> 状态：架构评审稿 v4.2（2026-08-17）：飞书 ④→②（PR #157 上游事实）；版本快照口径对齐 SDS v0.2
> 代码快照：`8027dde`，工作区含未提交变更。代码证据区分 HEAD 与工作区版本。
> 上游事实：PR #157（飞书集成，14 commits）已于 2026-08-16 合入 `openma-ai:main`，含数据库/Provider/Node WS Runner/Console/迁移/文档，真实发送/读取工具、凭据加密、去重、断线退避、自动回复链路；PR 记录全仓测试 1727 passed，并完成真实自建应用 `publish → @mention → threaded reply` E2E。飞书证据以社区主线为准。
>
> 证据规则：测试文件存在不等于测试已执行。只有记录了命令、运行时、结果和日期的测试才计为验收证据；本文未附执行记录的测试一律表述为"测试资产存在，本轮未执行，不计目标环境验收"。

## 1. 评级定义

| 档位 | 定义 |
|------|------|
| ① 现成复用 | 有目标环境验收证据（命令/运行时/结果/日期），当前形态即可进产品。"在码"不构成① |
| ② 复用原语需产品化 | 机制存在；平台已有但目标环境未验收归此档，必须列产品化缺口 |
| ③ 新建领域能力 | 代码为零（或仅有可复用底座），按领域建模新建 |
| ④ 尚未验证 | 有设计/spike，无生产级验收证据，或有已知未完成的联调前置 |

工程模式类资产单列为"技术复用基础"，不参与①评级——它们不是产品能力。

**头部结论：按此口径，当前没有平台能力可直接计入目标 AIOps 客户环境验收。** 所有"已有能力"都需要一笔目标环境验收投入，预算与排期应据此申请。

## 2. 复用矩阵

### 2.1 技术复用基础（不评级）

| 资产 | 说明 |
|------|------|
| port/adapter/fake 工程模式 | integrations-core 先例，横向复制到新领域包（aiops/cmp） |
| drizzle 方言盲层 | db-schema `_shared/oma-db` 贯通 D1/SQLite/PG |

### 2.2 ② 复用原语需产品化

| 能力 | 代码证据 | 验收状态与缺口 |
|------|----------|----------------|
| 飞书集成（社区主线原生能力，非私有分支/项目定制） | PR #157（2026-08-16 合入 `openma-ai:main`，14 commits）：Provider、Node WS Runner、Console、迁移、文档；真实发送/读取工具、凭据加密、去重、断线退避、自动回复链路；全仓测试 1727 passed + 真实自建应用 E2E（publish → @mention → threaded reply） | 社区代码、测试与真实 E2E 已成立（②）。目标部署环境产品化验收未完成：凭据联调、租户隔离、稳定性、HA（WS Runner 单副本、无 leader election）、延迟采样、安全。升①最低验收覆盖：签名校验、重复事件、断线重连、租户隔离、消息幂等、发送失败恢复、审批身份校验、延迟采样 |
| 单 Agent Runtime | session-runtime 状态机/事件溯源 | 测试资产存在（单元/集成/E2E），本轮未执行，不计目标环境验收。已知缺口限定：`POST /messages` 一次性 SSE 边界未发 `session.status_idle`（docs/aiops-digital-employees.md:141）；长期 `/events/stream` 为另一通道（packages/http-routes/src/sessions/index.ts:837），不受该缺口影响 |
| AuthN · 邮箱密码 | auth-config.ts:42 | 待补（无列示 E2E） |
| AuthN · Email OTP | 依赖 SMTP 绑定 | 待补（无真实邮件 E2E） |
| AuthN · Google | 依赖环境变量 | 待补（无真实 IdP E2E） |
| 密钥两层 Vault | vaults/credentials + oma-vault sidecar | 测试资产存在；目标环境联调待补 |
| 多 agent 委派 · CF | tools.ts:1193 `call_agent_*` 派生 + delegateToAgent 注入（SessionDO 路径） | 待补（产品级验收未做）；注：子 Agent 委派当前只传 Agent ID 不传 version，见 P0 底座 B |
| 多租户 | membership / x-active-tenant 校验 | 已有局部租户隔离测试；尚未完成全资源、全后台任务、双运行时和跨租户攻击面的系统验收 |
| RBAC | owner\|admin\|member 角色字段 | 待补（权限矩阵与统一检查点未建） |
| 安全审计 | append-only 事件日志（EventBase 无统一 actor/tenant/resource/result 字段） | 待补（统一审计模型、脱敏、留存、防篡改未建） |
| HITL 暂停/恢复 | requires_action 协议（types.ts:407） | 待补（原语级测试未列示执行记录） |
| 企业配额 | quotas 包（abuse 型：session 数/上传频次大小） | 待补（模型预算/Agent 并发/工具调用额度未建） |
| 通知渠道抽象 | provider/installation/webhook 模式 | 待补（统一通知通道未建） |
| Console 管理面（仅管理配置场景） | 35 路由 + 插件注册表（hosted-only） | Playwright specs 存在，未附执行记录，不计验收 |
| 评测框架 | eval-core/evals-runner + trajectory v1 规范 | 测试资产存在；轨迹 v1 规范不等于生产验收 |

### 2.3 ③ 新建领域能力

| 能力 | 范围 |
|------|------|
| SSO 集成 | 底座=better-auth 可复用；SSO 插件接入、配置模型、IdP 管理、DB 迁移、角色映射、验收全部待实现（repo 未装插件，无独立 spike）。路线图中为 P0/P1 可选准入工作流：企业客户首期要求统一登录时启动 |
| Operations Workspace | BFF + Run 数据模型 + 服务模板；复用前端技术栈与登录态，不用插件注册表 |
| 审批业务服务 | 建于 HITL 原语之上，全量范围见 §4 |
| Knowledge Service | 全生命周期范围见 §5；接口先行、存储后定 |
| 告警/CMDB/ITSM 领域 | aiops_alerts 等模型 + 连接器；packages/aiops、cmp 尚未建立领域包；CMDB/ITSM 只做连接器不重建 |
| 策略门 | 接口与决策日志模型 P1 定义，实现（OPA/Cedar）P2 定案 |
| 最小工作流状态机 | 通用状态/超时/重试/补偿协议（P1）；具体运维动作与领域回退在 P2 |

### 2.4 ④ 尚未验证

| 能力 | 现状与升级路径 |
|------|----------------|
| 多 agent 委派 · Node | delegateToAgent 未接入 session-runtime/main-node，无可验收闭环（Phase 0 SDS 范围） |
| 外挂会诊编排 | sidecar=909 行/71.2s/2026-08-14/单次本地 CLI spike，外挂 REST 轮询，非生产验收（注意：该 spike 验证的是外挂多 agent 会诊，不作为单 Agent Runtime 证据） |
| 租户分片迁移/故障恢复 | 设计存在（tenant-db/shard_pool），生产验收未做 |

## 3. 实施路线

### P0 —— 工作台与治理底座

Workspace BFF · 服务模板 · Run 数据模型 · RBAC 权限矩阵与检查点 · 审计基础（统一模型+脱敏）。

**底座 A · 租户所有权基线**（原则，非机械加字段）：

1. 每个聚合根必须具有明确 tenant ownership；
2. 子资源必须不可绕过地继承租户边界；实现机制可按领域选择复合键、FK、tenant-scoped repository 或事务约束等价物，不机械要求 FK；
3. 所有查询与后台任务必须从可信上下文获得 tenant；
4. 高风险表可冗余 tenant_id 以强化查询与约束；
5. 用真实跨租户负向测试证明隔离，而不是只检查字段存在。

**底座 B · Agent 版本解析与 Session 快照冻结（三个实际缺口）**

现况：平台**已有** Session 创建时固化完整 `agentSnapshot` 的机制（`packages/http-routes/src/sessions/index.ts:296,341,363,443`；Runtime 优先读取快照：`apps/agent/src/runtime/session-do.ts:399`），因此缺口不是“Session 尚无 resolved snapshot”，也不需要新增快照列。真实缺口为：

1. **G1 · 显式版本未生效**：Session API 接受 `{id, version}`，但当前只使用 id，并按当前 Agent 生成快照；
2. **G2 · 委派不传播版本**：子 Agent 委派只传 Agent ID，未从调用 Agent 的已解析 `callable_agents` roster 传播并固定目标版本；
3. **G3 · 构建/冻结边界未显式建模**：`sessions-store` 更新接口允许改写 `agent_snapshot`；同时集成发布链路存在“创建 Session 后、Runtime init 前”按会话补充 MCP 配置的合法构建期更新，不能简单按“DB 创建后全部拒绝”封堵。SDS 必须先定义 snapshot 的构建完成/冻结时点，再保证冻结后不可变。

底座 B 的交付范围：指定版本解析（当前版本在 `agents`、历史版本在 `agent_versions`，全程 tenant scope）；递归委派树的版本传播；构建期与冻结期状态边界；Node/CF 分环境、跨租户、并发与冻结后拒写测试。详细设计与 go-ahead 门见 `p0-version-snapshot-sds.md`。

**Run resolved snapshot 属于另一聚合**：服务模板版本、申请参数、工作流、知识源、审批策略、计划与证据由 Run 模型 spec 定义，不塞入 Session `agent_snapshot`，也不作为底座 B 已实现能力。

**可选准入工作流**：SSO（企业客户首期要求统一登录时启动，见 §2.3）。

### P1 —— 审批、知识、协议

审批服务（§4）· 最小工作流状态机（仅通用状态/超时/重试/补偿协议）· 知识连接器与检索（§5）· 策略引擎接口与决策日志模型定义（实现留 P2）· Node 原生委派补齐+验收（独立 parity 工作流：首期若部署 CF，此项不阻塞主线）。

### P2 —— 领域闭环与受控执行

告警/CMDB/ITSM 闭环 · 策略门实现（OPA/Cedar 定案）· 受控执行与具体运维动作、领域回退。

（P1/P2 回退分界：P1 提供通用状态、超时、重试、补偿协议；P2 实现具体运维动作与领域回退。）

### P3 —— 扩面与度量

自动修复扩面 · 评测 · MTTR/干预率看板。

## 4. 审批服务验收范围

| 项 | 说明 |
|----|------|
| 审批人解析 / 转交 / 代理 | 超时与升级路径 |
| 申请人与审批人职责分离（SoD） | 硬约束，非 UI 提示 |
| 绑定不可变 plan_hash / evidence_snapshot_id | 审批对象可寻址唯一 |
| 计划或证据变化自动失效旧审批 | 堵"审批 A 执行 B" |
| 多级审批 / 会签 / 或签 / 附条件批准 | 条件批准需在执行前做条件执行校验 |
| 重复回调与并发决策幂等 | 卡片重放/双击不能双批 |
| 飞书卡片签名与权限校验 | 卡片操作者=有权审批者 |
| 撤回 / 驳回后重提 / 策略例外 | 例外本身留痕 |
| 审批操作审计 | 进 P0 统一审计模型 |

## 5. Knowledge Service 范围（全生命周期）

| 维度 | 内容 |
|------|------|
| 接入与同步 | 数据源接入、增量更新、删除传播 |
| 权限 | ACL 同步 + 查询时权限裁剪（非仅过滤） |
| 内容管线 | 分块、索引、Embedding 版本管理 |
| 时效性 | 失效知识、来源状态、新鲜度标注 |
| 检索接口 | 权限过滤 + 引用溯源（先定接口） |
| 质量 | 检索质量评测、引用正确性验收 |
| 存储选型 | pgvector/sqlite-vec/单一实现——接口冻结后再选，不为双运行时维护两套检索语义 |

## 6. 开源候选与决策标准（未定案）

| 需求 | 候选 | 决策标准与时点 |
|------|------|----------------|
| 策略引擎 | OPA vs Cedar | P1 定义接口与决策日志模型；P2 定案：嵌入形态（sidecar vs wasm）、策略可审计性、双运行时部署成本 |
| 检索存储 | 见 §5 | Knowledge Service 接口冻结后 |
| SSO | better-auth SSO 插件 | 默认路径；Keycloak 仅客户要求统一身份代理时 |

## 7. 经代码核验保留的结论

以下结论经 2026-08-17 只读实扫与复审引用交叉核验保留：

1. Memory Store 不等于向量 RAG；
2. `aiops_alerts`、`approval_requests` 无代码实体——bayer RFP 响应矩阵两处表述超前于代码，该文档未提交，为修正窗口；
3. CMDB/ITSM 做连接器，不重建客户已有系统；
4. port/adapter/fake 模式作为新领域包的工程基座；
5. 外挂 sidecar 定位为协议与 Agent 分工实验，不升格为产品编排器。
