# CMDB MCP 连接器 Spec：服务契约 + 通路接线 + 部署 (v0.2)

- 状态：**评审通过**（2026-08-19 起草，同日评审通过，8 项修改落地）
- 实施分支：`feat/cmdb-mcp`（基线 `main`@3882bee）

## 1. 范围与阶段分界

| | 内容 | 不含 |
|---|---|---|
| P0（本 spec 覆盖） | `apps/cmdb-mcp` 适配服务（3 只读工具）；main-node 远程 MCP 客户端通路（`mcpFetch` 接缝）；compose/文档/挂载脚本 | 写操作、审批门控、CF 侧、stdio、vault seam 实现、`get_topology`（P1） |

前置依赖：Phase 0 CMDB API 探测（输出：REST 端点清单、认证头形状、CA 证书 PEM）。**探测结果只影响 §5 cmdb-client 的映射细节，不改变本 spec 其余契约。**

## 2. 架构总览

```
┌──────────┐  mcp__cmdb__* 工具调用(JSON args)  ┌───────────────┐
│  Agent   │ ───────────────────────────────▶ │  main-node    │
│ (模型)   │                                   │ buildTools    │
└──────────┘                                   └──────┬────────┘
                                                      │ plain HTTP (compose 内网, 可选 ingress token, D-2)
                                                      ▼
                                              ┌────────────────┐  Authorization: <CMDB_AUTH_SCHEME> <token>
                                              │  oma-cmdb-mcp  │ ─────────────▶ https://10.0.21.209
                                              │ :3910/mcp      │   (token + 内网 CA 只在此容器)
                                              └────────────────┘
```

分层职责（凭证/TLS 封装原则）：

| 层 | 持有 CMDB token | 持有内网 CA | 说明 |
|---|---|---|---|
| agent 沙箱 | ❌ | ❌ | 模型只产 JSON args；bash 可路由到 10.x 但无凭证 |
| main-node | ❌ | ❌ | env 无任何 CMDB 变量（AC-4 检查） |
| cmdb-mcp | ✅ | ✅ | 唯一凭证边界；token 不入 vault、不入 agent 配置 |

## 3. MCP 工具契约（首发 3 只读，D-3）

工具名 = `mcp__cmdb__<tool>`（`<server>.name = "cmdb"`）。返回一律 `{content:[{type:"text",text:JSON.stringify(result)}]}`，`isError:true` 表业务失败。

> **两层返回结构说明**：MCP 协议层信封为 `{content:[{type:"text",text:"..."}], isError?:true}`；`text` 字段内为下述业务数据 JSON。成功时 `isError` 省略或 `false`；失败时 `isError:true` 且 `text` 为 §3.4 定义的错误信封。

### 3.1 `get_entity` — 按 ID/主机名/IP 查实体

```jsonc
// input (zod)
{ "entity_id"?: string, "hostname"?: string, "ip"?: string }   // 三选一，互斥校验
// result
{ "entity": { "entity_id": string, "entity_class": "host"|"vm"|"container"|"database"|"middleware"|"network"|"k8s"|"service"|"unknown",
              "hostname"?: string, "ips"?: string[], "owner_team"?: string, "labels"?: Record<string,string>,
              "raw"?: unknown },                                  // raw = CMDB 原始载荷透传（诊断用）
  "source": "cmdb" }
```

### 3.2 `search_entities` — 按类/标签/团队搜索

```jsonc
// input
{ "query"?: string, "entity_class"?: string, "labels"?: Record<string,string>,
  "owner_team"?: string, "limit"?: number }                       // limit 默认 20，上限 100
// result
{ "entities": Entity[], "total": number, "truncated": boolean }
```

### 3.3 `get_relationships` — 实体直接关系

```jsonc
// input
{ "entity_id": string, "direction"?: "out"|"in"|"both" }         // 默认 both
// result
{ "relationships": [ { "from_entity_id": string, "to_entity_id": string,
                       "relation": "runs_on"|"depends_on"|"connects_to"|"part_of"|"unknown" } ] }
```

> `get_topology`（多跳拓扑）移至 P1。首发阶段模型可通过多次调用 `get_relationships` 逐层遍历来模拟拓扑查询。

`Entity`/`Relationship` 词表复用被 revert 的 `73c45a0:packages/cmp/src/domain.ts`（P2 复活写操作时零迁移）。

### 3.4 错误契约

工具级错误（`isError:true`）统一信封：

```jsonc
// text 字段内的错误 JSON
{
  "error": {
    "code": string,       // 见下表
    "message": string,    // 人类可读描述
    "retryable": boolean, // 供模型决定重试策略
    "details"?: unknown   // 可选：上游原始错误体
  }
}
```

| 错误码 | 触发条件 | retryable | 说明 |
|---|---|---|---|
| `CMDB_AUTH_FAILED` | CMDB 返回 401/403 | false | token 无效或过期 |
| `CMDB_NOT_FOUND` | CMDB 返回 404 或查询无结果 | false | 实体不存在 |
| `CMDB_VALIDATION` | 工具参数校验失败（zod） | false | 入参不合法 |
| `CMDB_BAD_RESPONSE` | CMDB 响应 zod 解析失败 | false | 上游返回了意料之外的格式 |
| `CMDB_UPSTREAM_TIMEOUT` | 请求超时（含重试后） | true | 网络慢或 CMDB 过载 |
| `CMDB_UPSTREAM_UNAVAILABLE` | 5xx 或网络错误（重试后） | true | CMDB 临时不可用 |
| `CMDB_RATE_LIMITED` | CMDB 返回 429 | true | 速率限制 |

JSON-RPC 协议层错误维持标准码：`-32700`(parse error)、`-32600`(invalid request)、`-32601`(method not found)、`-32602`(invalid params)。

## 4. JSON-RPC 线上契约（对照 `@ai-sdk/mcp` 2.0.22 dist 核实）

| 方法 | 服务端行为 |
|---|---|
| `initialize` | 应答 `protocolVersion: "2024-11-05"`（与仓内 Linear MCP 先例 `gateway.ts:672-673` 一致，固定版本不做协商）；`capabilities:{}`；`serverInfo:{name:"oma-cmdb-mcp",version}` |
| `notifications/*`（initialized 等） | **HTTP 204**（不是 202——202 会触发 SDK 开后台 SSE GET，撞 405 报 `onerror`） |
| `tools/list` | `{"tools":[{name,description,inputSchema}]}`（无 cursor，全集返回） |
| `tools/call` | §3 结果形状 + §3.4 错误信封；未知工具 → JSON-RPC error `-32602` |
| `GET /mcp` / `DELETE /mcp` | 405（无状态服务端，不做 SSE 通道） |
| 响应头 | **不返回 `mcp-session-id`** → 客户端保持无状态 |
| Content-Type | POST 响应普通 `application/json`（无需 SSE/stream） |

HTTP 面：`POST /mcp`、`GET /healthz`（200 + `{"ok":true}`，healthcheck 用）。实现 = 手搓 JSON-RPC 分发（纯函数 `mcp.ts` + 裸 `node:http`，零运行时依赖，D-1）。

## 5. cmdb-client 适配层（探测不确定性的唯一收敛点）

- **配置**（`config.ts`，缺必填快速失败）：

| env | 必填 | 默认 | 说明 |
|---|---|---|---|
| `PORT` | 否 | 3910 | 监听端口 |
| `CMDB_BASE_URL` | ✅ | — | 如 `https://10.0.21.209` |
| `CMDB_API_TOKEN` | ✅ | — | 从 `.env` 注入，不落仓库 |
| `CMDB_AUTH_HEADER` | 否 | `Authorization` | PR-7：适配头名 |
| `CMDB_AUTH_SCHEME` | 否 | `Bearer` | `Bearer <t>` / 空=裸 token / `X-API-Key` 时忽略 scheme |
| `CMDB_MCP_INGRESS_TOKEN` | 否 | （空=不验证） | D-2：可选入站认证，为混部留路 |
| `LOG_LEVEL` | 否 | `info` | 过滤级别（debug/info/warn/error） |
| `REQUEST_TIMEOUT_MS` | 否 | 10000 | 上游超时 |

- **入站认证**（D-2）：当 `CMDB_MCP_INGRESS_TOKEN` 非空时，`POST /mcp` 请求须携带 `Authorization: Bearer <token>`，否则返回 401。默认空 = 不验证（compose 内网边界足够）。
- **出站请求**：认证头 + 10s 超时 + 5xx/网络错误重试 1 次（幂等 GET）；
- **入站解析**：每个响应过 zod，失败记 passthrough 日志并映射为 §3.4 `CMDB_BAD_RESPONSE`（不崩服务）；
- **归一化**：CMDB 原生字段 → §3 的 `Entity`/`Relationship`；映射表是 Phase 0 探测后唯一需回填的代码；
- **TLS**：容器内 `NODE_EXTRA_CA_CERTS=/app/certs/cmdb-ca.crt`（D-5 主路径）。

## 6. main-node MCP 客户端通路（`mcpFetch` 接缝）

### 依赖链标注

```
buildTools 回调 (:574)
  └─→ packages/agent buildTools() → tools.ts:1118 MCP 块
       └─→ env.mcpFetch 在此注入（工厂函数模式）
            └─→ experimental_createMCPClient({ transport: { type:"http", url, fetch: mcpFetch(server) } })

buildHarnessContext (:599-638)
  └─→ 将 buildTools 的输出合并进 HarnessContext.tools (:624-627)
       └─→ 位于 MCP 注册下游，零改动
```

> `mcpFetch` 是一个**工厂函数**：接受 server 配置，返回一个 `fetch` 函数供 SDK transport 使用。这与 CF 路径中 `proxyFetch` 闭包捕获 `mcpBinding` 的模式一致。`_sessionId` 不动——无状态无 per-session 路由。

### 变更

**`apps/agent/src/harness/tools.ts`**（~15 行增量，CF 路径字节不变）：

1. env 类型（~:371 `mcpBinding` 旁）新增：
   ```ts
   /** Node self-host MCP transport — factory that returns a fetch function.
    *  Absent mcpBinding + absent mcpFetch both disable MCP registration
    *  (legacy path). */
   mcpFetch?: (server: { name: string; url: string; authorization_token?: string }) => typeof fetch;
   ```
2. 守卫（:1119）放宽：`if ((!env?.mcpBinding || !env?.tenantId || !env?.sessionId) && !env?.mcpFetch)`；
3. 循环内：`mcpBinding` 存在 → 现有 `proxyFetch`（云端不变）；否则 `env?.mcpFetch` 存在 → `env.mcpFetch(server)` 作 transport `fetch`。

**`apps/main-node/src/lib/node-mcp-fetch.ts`**（新，~50 行）：`createNodeMcpFetch()` v1 = `globalThis.fetch`，`server.authorization_token` 存在时包 `Authorization: Bearer`；注释标记 deferred vault seam（`pickCredentialByHost`，D-4）。

**`apps/main-node/src/index.ts`**（~2 行）：buildTools 回调 env 增传 `mcpFetch: nodeMcpFetch` + import。**api-types 零改动**（`type` 为自由字符串，运行时只读 `server.url`，`tools.ts:1131`）。

## 7. 部署（docker-compose）

```yaml
  oma-cmdb-mcp:
    build: { context: ., dockerfile: apps/cmdb-mcp/Dockerfile }
    image: openma/cmdb-mcp:dev
    environment:
      PORT: "3910"
      CMDB_BASE_URL: ${CMDB_BASE_URL:-https://10.0.21.209}
      CMDB_API_TOKEN: ${CMDB_API_TOKEN:-}
      CMDB_AUTH_HEADER: ${CMDB_AUTH_HEADER:-Authorization}
      CMDB_AUTH_SCHEME: ${CMDB_AUTH_SCHEME:-Bearer}
      CMDB_MCP_INGRESS_TOKEN: ${CMDB_MCP_INGRESS_TOKEN:-}
      NODE_EXTRA_CA_CERTS: /app/certs/cmdb-ca.crt
      LOG_LEVEL: ${CMDB_MCP_LOG_LEVEL:-info}
    volumes:
      - ./secrets/cmdb-ca.crt:/app/certs/cmdb-ca.crt:ro
    mem_limit: 256m
    restart: unless-stopped
    healthcheck:
      test: ["CMD","node","-e","fetch('http://localhost:3910/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
    # 不发布端口（publish 无 host mapping）——仅 compose 内网可达
    # 与 oma-server 在同一 compose 默认 bridge 网络中
```

`pnpm-workspace.yaml` 增 `apps/cmdb-mcp`；`.env.example` 增 5 个 CMDB 变量（`CMDB_BASE_URL` / `CMDB_API_TOKEN` / `CMDB_AUTH_HEADER` / `CMDB_AUTH_SCHEME` / `CMDB_MCP_INGRESS_TOKEN`(可选注释)）；`scripts/attach-cmdb-mcp.ts` 幂等 PATCH 5 个 aiops 数字员工的 `mcp_servers`（条目 `{name:"cmdb",type:"url",url:"http://oma-cmdb-mcp:3910/mcp"}`）。

## 8. 测试计划

| 层 | 用例 | 承重 |
|---|---|---|
| 协议对打（`apps/cmdb-mcp/test/mcp-protocol.test.ts`） | 起真 http-server + 真 `experimental_createMCPClient`(@ai-sdk/mcp@2.0.22)：initialize 版本协商、tools/list 全集、tools/call 往返、204 通知、无 session-id 无状态、**isError 错误信封断言**、**ingress token 401/放开两态** | ★ 消费端契约 |
| 单元（`cmdb-client.test.ts`） | mock fetch：认证头形状（header×scheme 组合）、超时、重试、zod 失败→`CMDB_BAD_RESPONSE`、**错误码映射表全行覆盖**（401→AUTH_FAILED, 404→NOT_FOUND, 429→RATE_LIMITED, 5xx→UPSTREAM_UNAVAILABLE, timeout→UPSTREAM_TIMEOUT） | 映射正确性 |
| 回归守卫（`test/unit/tools-mcp-node.test.ts`） | buildTools + mcpFetch 对 fixture JSON-RPC server：注册 `mcp__cmdb__*`、经接缝执行、**无 mcpFetch 仍静默跳过** | 平台接缝 |
| 存量回归（改前后各跑一次） | `tools-execution` / `inject-mcp-servers-into-snapshot` / `mcp-proxy-refresh` + main-node 包 18 文件 + agent/main-node `tsc --noEmit` | CF 不受害 |
| 端到端门 | compose up → attach 脚本 → console MCP tab 见条目 → 会话真实查询 → trajectory 有 `mcp__cmdb__get_entity` tool_use | AC-1 |
| 安全门 | `oma-server` env grep CMDB 为空；`./data` grep token 前缀仅宿主机 `.env` 命中 | AC-4 |

## 9. 实现不变量（验收的测试义务）

1. token 唯一落点 = cmdb-mcp 容器（env）+ 宿主机 `.env`；任何代码路径不得将其写入日志/agent 配置/DB。
2. `NODE_TLS_REJECT_UNAUTHORIZED` 若被使用，只允许出现在 cmdb-mcp 容器 env（D-5 逃生舱），禁止进 oma-server/共享代码。
3. CF 路径字节不变：无 `mcpFetch` 时 `tools.ts` 行为与现状完全一致（回归守卫断言）。
4. cmdb-mcp 失败（超时/5xx/协议错）→ 单 server 跳过 + 结构化日志，会话不崩（PR-6）。
5. 手搓 JSON-RPC 面只允许 3 方法 + 2 HTTP 端点；新增方法必须先改 §4 契约再改码。
6. 工具级错误必须使用 §3.4 统一信封格式（`{error:{code,message,retryable}}`）；不得返回裸字符串错误。
7. 日志不得打印 token 值、Authorization 头值、或任何凭证片段（红线，§X 规范）。

## 10. 结构化日志规范

cmdb-mcp 为保 D-1 零运行时依赖，使用 ~30 行自建 logger util 输出 pino 兼容 JSON 行。

### 格式

```json
{"level":30,"time":1787132843227,"service":"cmdb-mcp","op":"tools.call","tool":"get_entity","duration_ms":142,"msg":"tool call ok"}
```

| 字段 | 说明 |
|---|---|
| `level` | pino 级别号：debug=20, info=30, warn=40, error=50 |
| `time` | `Date.now()` 毫秒时间戳 |
| `service` | 固定 `"cmdb-mcp"` |
| `op` | 操作标识（如 `cmdb-mcp.startup`, `tools.call`, `cmdb-client.request`） |
| `msg` | 人类可读描述 |
| 其余 | 结构化上下文字段（`tool`, `duration_ms`, `err`, `status_code` 等） |

### 级别使用约定

- **info**：启动、工具调用成功、healthcheck
- **warn**：zod 解析降级（passthrough）、ingress token 缺失但未配置
- **error**：CMDB 上游错误（5xx/超时/认证失败）、JSON-RPC 协议错误

### 红线

- **永不打印**：`CMDB_API_TOKEN` 值、`Authorization` 头值、`CMDB_MCP_INGRESS_TOKEN` 值
- 可打印：token 前缀（如 `"token_prefix":"sk-...***"`）仅限 debug 级别诊断

### 与 main-node 格式对齐

main-node 使用 `@open-managed-agents/observability` 的 `createNodeLogger`（pino 实例），输出相同的 JSON 行格式（`{level,time,service:"main-node",op,msg,...}`）。cmdb-mcp 的 logger 格式与之兼容，可用相同的 `grep`/`jq` 管线统一分析。

## 11. 开放问题（Phase 0 探测回填）

- 认证头真实形状（Bearer/裸 token/X-API-Key/自定义）→ 回填 `.env` 实例值与 `cmdb-client.test.ts` 组合用例；
- REST 端点与字段名（entity 查询/搜索/关系 API 是否存在、分页形状）→ 回填 §5 映射表；若关系 API 缺失 → 首发降为 2 工具；
- swagger/openapi 是否可用（`/swagger`、`/v3/api-docs`、`/openapi.json`、`/api-docs`）→ 决定映射表的手工成本；
- CA 证书可导出性（`openssl s_client -showcerts`）→ D-5 主路径 vs 逃生舱。
