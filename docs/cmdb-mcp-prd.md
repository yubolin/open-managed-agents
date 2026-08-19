# CMDB 查询能力 PRD（cmdb-mcp）(v0.2)

- 状态：**评审通过**（2026-08-19 起草，同日评审通过，8 项修改落地）
- 上游输入：用户需求"让 OpenMA 通过 MCP 的方式访问 CMDB（https://10.0.21.209）"；已锁定决策——自研 CMDB REST API / docker compose 自托管（main-node）/ 平台级通用能力 / API Token 环境注入
- 下游输出：`docs/cmdb-mcp-spec.md`（已解冻，v0.2 同步更新）

## 1. 背景与问题

AIOps 线（aiops_alerts 域已落地）的告警分诊、值班排障需要 CMDB 富化：告警对象 → 实体（主机/容器/中间件）→ 负责人/团队 → 依赖拓扑。当前状态：

1. **平台能力缺口**：agent 配置层已有 `mcp_servers[]` 一等字段（`packages/api-types/src/types.ts:49-68`），CF 路径 MCP 完整，但自托管 main-node 路径**远程 MCP 客户端通路整块缺失**——`buildTools` 未传 MCP 上下文，MCP 块静默跳过（`apps/agent/src/harness/tools.ts:1119-1125`；`apps/main-node/src/index.ts` buildTools 回调）。
2. **信任链缺口**：全仓无内网 CA 信任支持（零 `NODE_EXTRA_CA_CERTS`/自定义 CA 产品化代码）；CMDB 在内网 `https://10.0.21.209`，证书为内网 CA/自签。
3. **既有先例的教训**：仓内曾有硬编码 native 工具路径（feishu-agent-tools；以及被 revert 的 `73c45a0` CMP 设计）——能力与平台代码耦合，每加一个内网能力都要改平台代码，不可扩展。

## 2. 产品定义

为 OpenMA 自托管部署提供一个**平台级、协议标准化（MCP）的 CMDB 只读查询能力**：

- 形态 = 一个独立的 `cmdb-mcp` 适配服务（compose 内网）+ main-node 补齐通用 MCP 客户端通路；
- 任意 agent 在配置里声明一条 `mcp_servers` 条目即获得 `mcp__cmdb__*` 工具；
- CMDB token 与内网 CA 证书**只存在于 cmdb-mcp 一个容器**，agent 沙箱与 main-node 进程永不可见。

## 3. 目标用户与角色

| 角色 | 用途 |
|---|---|
| AIOps 数字员工（duty-supervisor + 4 专家） | 告警分诊时富化实体/负责人/拓扑 |
| 运维编排 run（operations catalog） | 诊断流程中的 CMDB 查询步骤（P1） |
| 平台租户的任意自定义 agent | 按需挂载（平台级通用能力） |
| 平台运维者 | 部署/轮换 token/挂证书（compose 级操作，不改代码） |

## 4. 核心用户旅程（首发）

1. **运维者**：`.env` 填 `CMDB_API_TOKEN`，`secrets/cmdb-ca.crt` 放证书，`docker compose up -d oma-cmdb-mcp`。
2. **租户/开发者**：给 agent 的 `mcp_servers` 加 `{name:"cmdb", type:"url", url:"http://oma-cmdb-mcp:3910/mcp"}`（console MCP tab 或 REST）。
3. **agent 会话**：用户问"10.0.21.x 是什么设备、归谁管、依赖谁"→ 模型调 `mcp__cmdb__get_entity` / `mcp__cmdb__get_relationships` → 返回结构化 JSON → 回答含实体、负责人团队、拓扑。
4. **aiops 种子脚本**：`scripts/attach-cmdb-mcp.ts` 幂等地给 5 个数字员工挂上 cmdb 条目。

## 5. 阶段范围

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0（本次） | cmdb-mcp 服务（3 只读工具）+ main-node MCP 通路 + compose/文档/挂载脚本 | Phase 0 CMDB API 探测（认证头/端点形状） |
| P1（后续） | `get_topology`（多跳拓扑，模型可用 `get_relationships` 多步模拟）；operations run 步骤化消费；工具清单按真实使用反馈扩展（分页/模糊搜索增强） | P0 落地 |
| P2（后续） | 写操作 + 审批门控（复活 `73c45a0` 闭环设计的词表）；ITSM/监控连接器同模式复制 | P0 + 审批体系联调 |

## 6. 关键产品需求（PRD 级）

- **PR-1 协议形态**：能力以 MCP（streamable-http，无状态）暴露；agent 侧工具名 `mcp__cmdb__*`。
- **PR-2 挂载模型**：per-agent 配置声明制——只注册声明过的 server（复用现有工具注册层即网络策略，`tools.ts:1115-1117`）；不声明则该 agent 完全看不到 CMDB 工具。
- **PR-3 只读首发**：首发 3 只读工具（查询/搜索/关系）；`get_topology`（多跳）移至 P1（模型可用 `get_relationships` 多步调用模拟）；写操作进 P2 且必须过审批门控。
- **PR-4 凭证隔离**：CMDB token 只进 cmdb-mcp 容器 env（`.env` → compose）；不进 agent 配置、不进 vault、不进沙箱、不进 main-node 进程 env。
- **PR-5 TLS 封装**：内网 CA 证书只挂载进 cmdb-mcp 容器（`NODE_EXTRA_CA_CERTS`）；平台其余组件零 TLS 改动。
- **PR-6 降级语义**：cmdb-mcp 不可达/超时 → 该 server 工具注册失败被跳过并留日志，会话不崩（沿用现有 15s 超时 + 单 server 容错，`tools.ts:1181-1187`）。
- **PR-7 可配置认证形状**：CMDB 认证头名/方案可配（`CMDB_AUTH_HEADER`/`CMDB_AUTH_SCHEME`），适配探测结果，不锁死 Bearer。
- **PR-8 通用性**：main-node MCP 通路是通用设施——第二个内网 MCP 能力（ITSM/监控）落地时**零平台代码**，纯配置。

## 7. 非功能（建议值，待评审定标）

| 项 | 值 | 说明 |
|---|---|---|
| 工具调用延迟 P95 | ≤ 800ms（不含 CMDB 自身耗时） | compose 内网一跳 + 无状态握手亚毫秒级 |
| CMDB 故障隔离 | 100%（单 server 跳过） | 不影响会话其他工具 |
| token 泄露面 | 0（沙箱/main-node/agent 配置均无 token） | PR-4 验收时交叉检查 |
| 证书轮换 | 换文件 + 重启容器，≤ 1min | 无代码变更 |

## 8. 验收标准（标注 P0）

- **AC-1（通路）**：从 `main` 切的 feature 分支上，console 某 agent MCP tab 配置 cmdb 条目后，会话中出现 `mcp__cmdb__*` 工具且可执行（端到端真实数据）。
- **AC-2（回归）**：根 vitest 全绿（重点 `tools-execution` / `inject-mcp-servers-into-snapshot` / `mcp-proxy-refresh`）+ main-node 包 18 测试文件全绿 + 新增 `tools-mcp-node.test.ts` 守卫"无 mcpFetch 仍静默跳过"。
- **AC-3（协议契约）**：cmdb-mcp 包内"真 @ai-sdk/mcp 客户端对打"测试绿——钉死 initialize 版本协商 / 204 通知 / 无 session-id 无状态语义。
- **AC-4（安全交叉检查）**：`docker compose exec oma-server env | grep -iE 'cmdb'` 为空；`./data` 全树 grep token 前缀仅命中宿主机 `.env`/compose 文件。
- **AC-5（文档）**：`docs/self-host.md` 含证书挂载、token 供给、agent 挂载、安全说明四要素。

## 9. 裁决记录（2026-08-19，评审稿待定夺）

| # | 议题 | 裁决 | 备注 |
|---|---|---|---|
| D-1 | MCP server 实现 | ✅ 手搓 JSON-RPC（~150 行，零传递依赖；仓内先例 `gateway.ts:671-769`） | 写操作时代再评估引 SDK |
| D-2 | 内网腿（main-node→cmdb-mcp）认证 | ✅ 加可选 `CMDB_MCP_INGRESS_TOKEN`（~5 行，为混部留路） | 默认空=不验证，compose 内网边界足够 |
| D-3 | 首发工具集 | ✅ 3 只读：get_entity / search_entities / get_relationships | `get_topology` 移 P1（模型可多步模拟） |
| D-4 | vault 凭证接缝 | defer（留 `mcpFetch` 形状 + 注释，不实现） | **风险**：token 轮换需重启 cmdb-mcp 容器（env 注入无法运行时更新）；P1 优先解决若 token 过期频繁 |
| D-5 | CA 信任路径 | ✅ 挂载证书 + `NODE_EXTRA_CA_CERTS`（零代码） | 逃生舱 `NODE_TLS_REJECT_UNAUTHORIZED=0` 仅限 cmdb-mcp 容器；**禁止**进 oma-server |

## 10. 非目标

- CMDB 写操作、审批门控闭环（P2，复活 `73c45a0` 设计时做）；
- CF/Workers 侧任何改动（CF 远程 MCP 本就可用；内网 IP 云端不可达是物理约束）；
- per-user skill/工具权限（另一议题）；
- Node 侧 stdio MCP 生成（CF-only 路径维持现状）；
- 重建 CMDB/ITSM 本体（只做连接器，对齐 `docs/aiops-platform-reuse-and-roadmap.md`）。

## 11. 对下游 spec 的输出（已解冻）

- 工具清单与参数 schema 定稿（依赖 Phase 0 探测的 REST 端点/字段形状）；
- JSON-RPC 线上契约细则（协议版本集/通知状态码/无状态语义）；
- cmdb-client 归一化模型（`CmdbEntity`/`CmdbRelationship`，词表源 `73c45a0:packages/cmp/src/domain.ts`）；
- main-node `mcpFetch` 接缝的精确 diff 形状与回归测试义务；
- 错误契约码表（工具级 + JSON-RPC 协议级）；
- 结构化日志规范（pino 兼容 JSON 行）。
