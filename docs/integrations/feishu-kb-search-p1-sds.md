# 飞书知识库搜索能力演进 — P1 SDS

> 状态：**v0.3（Revised Draft / No-go / 有界检索结果契约）**
>
> 来源：基于生产使用中“用户期望按关键词检索知识库，而 P0 只能枚举节点和阅读全文”的痛点演进。
>
> 定位：在 P0 指定知识空间浏览直达连接器（见 [feishu-kb-p0-sds.md](./feishu-kb-p0-sds.md)）的基础上，构建低延迟、高召回、具备可验证租户与权限隔离的飞书知识库检索能力。

---

## 1. 痛点与现状分析

### 1.1 P0 的能力边界与生产痛点
在当前 P0 连接器实现中（详见 [feishu-kb-p0-sds.md](./feishu-kb-p0-sds.md)）：
- 仅提供 4 个只读工具：`wiki_v2_space_list`、`wiki_v2_spaceNode_list`、`wiki_v2_space_getNode`、`docx_v1_document_rawContent`；
- **无关键词搜索接口**。
- **Agent 在搜索任务下的被动行为**：
  1. 递归枚举空间下的所有节点目录；
  2. 靠模型自行猜测可能命中的文档标题；
  3. 读取多篇文档的完整全文到上下文，通过 LLM “阅读理解”来回答。
- **后果**：单轮触发 7 次以上 MCP 工具与 8 次串行模型推理，耗时高达 70+ 秒，引发 22.8 万 Token 上下文膨胀，且容易遗漏深层子节点中的文档。

---

## 2. 核心架构决策：真实部署拓扑与可信租户身份

飞书搜索能力的落地必须严格遵守 OpenMA 的多租户与部署拓扑边界。我们明确区分两种拓扑模型：

```
───────────────────────────────────────────────────────────────────────────────
拓扑 A：自有 Search MCP 空间树缓存与标题搜索 (P1-Lite)
───────────────────────────────────────────────────────────────────────────────

  ┌──────────────┐ Streamable HTTP ┌────────────────────────┐ tenant_token ┌─────────────┐
  │  oma-server  │ ───────────────▶│  oma-feishu-search      │ ────────────▶│ open.feishu │
  │ (main-node)  │  /mcp (内网)     │  • 内存并发 Space 树缓存 │              │  .cn /apis   │
  └──────────────┘                 │  • 暴露 wiki_search     │              └─────────────┘
                                   └────────────────────────┘
  • 部署位置：新增 oma-feishu-search 服务；P0 oma-lark-mcp 保持不变
  • 凭证来源：Search 服务专属 Docker secret，不进入 main-node/Agent/索引表
  • 飞书边界：每个 Search 服务实例固定绑定单一 AppID/Feishu tenant
  • OMA 边界：仍须证明该 Sidecar 只服务对应 OMA tenant，不能据此宣称零跨租户风险

───────────────────────────────────────────────────────────────────────────────
拓扑 B：平台级全文本地 RAG 搜索 (P1-Pro)
───────────────────────────────────────────────────────────────────────────────

  ┌─────────────────────────────┐              ┌──────────────────────────────┐
  │ oma-feishu-search           │              │ oma-server / main-node       │
  │ • 持有 Feishu App secret    │              │ • 不持有 Feishu App secret   │
  │ • 拉取节点/正文/ACL         │              │ • in-process search tool     │
  │ • 写 chunks/tombstones      │              │ • 可信 tenant context 查询   │
  └──────────────┬──────────────┘              └──────────────┬───────────────┘
                 │ least-privilege write                       │ tenant-bound read
                 └──────────────────────┬───────────────────────┘
                                        ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ PostgreSQL (oma 数据库)                                                    │
  │ 表: feishu_kb_chunks                                                      │
  │ 主键/约束: (tenant_id, space_id, doc_token, chunk_index)                  │
  │ 索引: GIN(title/content gin_trgm_ops)，启用前验证 pg_trgm 扩展             │
  │ 隔离: 服务端 tenant context + SQL tenant filter + RLS/等价防线            │
  └───────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 技术方案深度对比与选型评估

| 评估维度 | 方案 A：用户 OAuth 原生搜索 | 方案 B：Sidecar 空间树并发检索 (拓扑 A, P1-Lite) | 方案 C：平台级 PG 全文与向量检索 (拓扑 B, P1-Pro) |
|---|---|---|---|
| **核心机制** | 引入用户 OAuth 凭证，调用官方搜索能力（实际 API 与权限须在 Spike 中验证） | 在自有 `oma-feishu-search` 中维护 Space 树缓存，按标题与路径匹配 | 同一 Search 服务同步分块与 ACL/tombstone，main-node 只查询本地索引；以 `pg_trgm` 候选召回 + 应用层排序为中文基线，可选中文分词/向量增强 |
| **搜索粒度** | 飞书官方全功能正文与节点搜索 | 节点标题、路径名模糊搜索（精准直达 node_token） | 文档段落级（Chunk-level）正文深搜与语义召回 |
| **凭证与身份** | 需要用户身份（`user_access_token`） | 维持应用身份（`tenant_access_token`），不增加用户 OAuth 权限 | Search 服务持有应用身份；main-node 与索引表不接触 App Secret |
| **技术复杂度** | 🔴 **高**（需用户授权、Token 轮转与多租户代理） | 🟡 **中低**（需新增自有 Search MCP，不能仅改 whitelist） | 🟡 **中高**（需同步、撤权、删除、中文检索与索引运维） |
| **数据库要求** | 无本地存储要求 | 纯内存缓存，无额外 DB 要求 | 目标 PG 镜像必须验证 `pg_trgm`；若启用向量需包含 `pgvector` 的受控镜像 |
| **飞书权限隔离** | 由飞书服务端按用户权限过滤 | 只能读取授予 App 的空间/文档，但仍需 OMA tenant 到 Search 实例的可信绑定 | SQL 必须带可信 `tenant_id`，并持续同步飞书 ACL/删除状态 |

---

## 4. 推荐演进路线与工具定义

### 4.0 与 Harness 上下文治理的强制契约

搜索的目标不是“更快地把全文交给模型”，而是把检索结果限制为**小而可追溯的候选片段**。本 SDS 与 [Harness 运行时上下文稳定性与大结果治理 SDS](../harness-context-stability-sds.md) 共同约束如下：

- `wiki_search_nodes` 只返回标题、路径、节点标识和匹配证据，不返回文档全文；
- `search_content` 默认 `top_k = 3`、服务端最大值 `5`，每个命中片段受独立 Token 预算约束，最终序列化响应总量不得超过服务端 `max_response_tokens`；
- `NodeSearchHit` 必须带 `space_id`、`node_token`、`title`、`parent_path`、`matched_fields` 和 `updated_at`；
- `ContentSearchHit` 才要求 `doc_token`、`section_path`、`chunk_index`、`snippet` 和 lexical score；只有向量能力真实启用时才返回 vector score；
- 若用户需要全文，Agent 必须显式调用读取工具；Harness 仍会对该结果执行大结果首入治理，搜索工具不得绕过；
- 工具在预算内优先减少 `top_k` 或缩短 snippet，并返回 `truncated: true` 与 `next_cursor`，不得静默截断或退化为整篇原文。
- Search MCP 自身设置服务端 hard cap；调用方可传 `max_result_tokens` 进一步收紧，但服务端始终执行 `min(requested, configured_cap)`。若当前 MCP transport 尚不能安全传递 Harness 动态预算，则先使用服务端固定上限，不信任模型自行选择无限预算。Harness 对返回值再执行第二层 admission guard。

建议的 `ContentSearchResponse` 形状：

```json
{
  "query": "SDS 全称",
  "top_k": 3,
  "truncated": false,
  "results": [
    {
      "space_id": "spc_xxx",
      "doc_token": "dox_xxx",
      "title": "Harness Context Stability SDS",
      "section_path": "1.2 Terminology",
      "chunk_index": 4,
      "snippet": "SDS means Software Design Specification ...",
      "scores": { "lexical": 0.83 },
      "updated_at": 1787356800000
    }
  ]
}
```

### 4.1 阶段一（P1-Lite 即时见效）：Sidecar 空间树快速索引与标题检索
由新增的 `oma-feishu-search` 暴露空间树检索工具：`mcp__feishu-kb__wiki_search_nodes`。

当前容器运行的是官方 `@larksuiteoapi/lark-mcp` CLI，不能仅靠 whitelist 配置新增自定义工具。v0.3 固定选择**新增 OpenMA 自有 `oma-feishu-search` 服务**，由它调用飞书 API 并暴露 `wiki_search_nodes`；不修改官方 P0 sidecar，也不采用长期维护 lark-mcp fork。该服务未实现前，不得把“在现有 sidecar 内补一个工具”计为已具备能力。
- **工具定义**：
  ```json
  {
    "name": "wiki_search_nodes",
    "description": "Fast search wiki nodes and documents by title/path across authorized knowledge spaces",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Keyword to search in document titles and node paths" },
        "space_id": { "type": "string", "description": "Optional: limit search to a specific space" },
        "top_k": { "type": "integer", "minimum": 1, "maximum": 20, "default": 10 },
        "cursor": { "type": "string", "description": "Opaque signed continuation cursor" },
        "max_result_tokens": { "type": "integer", "minimum": 128, "description": "Caller may lower, never raise, the server cap" }
      },
      "required": ["query"]
    }
  }
  ```
- **执行收益目标**：热缓存下通过一次搜索调用返回候选 `node_token`，再按需读取目标文档；延迟与召回率以第 5 节基准测试为准，不在设计阶段承诺未经测量的 `<500ms`。

### 4.2 阶段二（P1-Pro 深度检索）：平台级文档切片与 PG 全文/混合检索
- PostgreSQL 内置 `simple` FTS 不提供中文分词，不能将 `to_tsvector('simple', content)` 宣称为中文 BM25/全文检索方案。P1-Pro 基线使用经目标镜像验证的 `pg_trgm` 做标题与正文候选召回，再由应用层排序；中文分词 FTS 与向量召回均为独立可选能力。
- **数据表设计**：
  ```sql
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  CREATE TABLE feishu_kb_chunks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    node_token TEXT NOT NULL,
    doc_token TEXT NOT NULL,
    title TEXT NOT NULL,
    section_path TEXT NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    source_updated_at BIGINT NOT NULL,
    acl_version TEXT,
    last_permission_verified_at BIGINT NOT NULL,
    acl_valid_until BIGINT NOT NULL,
    deleted_at BIGINT,
    CONSTRAINT uq_chunk UNIQUE (tenant_id, doc_token, chunk_index)
  );
  CREATE INDEX idx_kb_chunks_title_trgm ON feishu_kb_chunks
    USING GIN(title gin_trgm_ops);
  CREATE INDEX idx_kb_chunks_content_trgm ON feishu_kb_chunks
    USING GIN(content gin_trgm_ops);
  CREATE INDEX idx_kb_chunks_tenant ON feishu_kb_chunks (tenant_id, space_id);
  ```
- 目标 PostgreSQL 镜像必须先执行 `CREATE EXTENSION pg_trgm` 的部署验证；若启用向量检索，则必须改用包含 pgvector 的受控镜像并单独迁移，`postgres:16-alpine` 本身不能视为已具备 pgvector。
- 同步 Worker 运行在 `oma-feishu-search`，从专属 Docker secret 获取 App 凭证，并使用只允许写 `feishu_kb_*` 表的数据库角色。服务实例启动时固定 `OMA_TENANT_ID + AppID` 绑定，模型输入、MCP 参数和 main-node 请求均不能覆盖该绑定。
- 同步协议必须支持分页全量基线、`source_updated_at` 增量水位、删除 tombstone、ACL 水位更新与幂等重放。一次同步只有在同一 generation 的 chunks/tombstones/ACL 水位提交完成后才发布新 `index_generation`；失败 generation 不对查询端可见。
- P1-Pro 采用 `main-node` in-process tool：认证路由将可信 `tenant_id` 写入服务端调用上下文，repository 强制 tenant filter，并用 PostgreSQL RLS 或等价的不可绕过防线做纵深保护；模型参数中不存在可覆盖 tenant 的字段。
- **执行收益目标**：直接返回最相关的少量正文片段，Agent 无需再将整篇文档读入上下文。

---

## 5. 验收准则与 TDD 规范

1. **P1-Lite 检索延时与准确率**：
   - 分开测量冷启动构树与热缓存查询；在固定 100、1,000、10,000 节点数据集上记录 P50/P95/P99，不混用 `<500ms` 与 `<800ms` 两套口径；
   - 用标注语料分别统计中文、英文、中英混合、缩写和路径标题查询的 Recall@K 与 MRR，目标值在 Spike 后冻结。
2. **多租户数据隔离测试**：
   - P1-Lite 的 Search 服务 URL、AppID 和 OMA tenant 绑定不可由模型选择；伪造工具参数不得切换租户；
   - P1-Pro 的 `tenant_id` 必须来自 main-node 认证上下文，禁止信任模型生成的工具参数；repository 漏写 tenant filter 时，RLS/等价防线仍须阻断跨租户读取。
3. **有界结果测试**：
   - 100 个候选命中时，响应严格遵守 `top_k`、单片段和总 Tool Result Token 预算；
   - 每个结果均可通过返回的 node/doc/chunk 标识回读并核对原文；
   - 按最终序列化 JSON（含 metadata/cursor）计量；超预算时返回 `truncated`/`next_cursor`，不得返回全文兜底；
   - cursor 必须签名并绑定 tenant、query hash、排序规则和 index generation；篡改、跨租户复用或索引代际失效时拒绝使用。
4. **权限撤销与索引删除测试**：
   - 每份缓存/索引记录带 `acl_valid_until` 或等价权限水位；App 被移出知识空间、文档删除或 ACL 收紧后，在冻结的撤权 SLA 内删除或屏蔽对应结果；
   - 超过最大陈旧时间、ACL 刷新失败或同步水位未知时采用 fail-closed，不得继续返回无法重新验证权限的旧片段；
   - 分别测试 P1-Lite cache eviction、P1-Pro tombstone/delete、刷新失败及恢复后的重新纳入。

---

## 6. Go/No-go 条件

当前结论：**No-go for implementation**。进入 TDD 前必须完成：

1. 冻结单 OMA tenant 到 `oma-feishu-search` 实例/AppID 的部署绑定与 secret rotation；
2. 冻结 Search 服务最小权限 DB role、generation 发布、tombstone 和 ACL 同步 SLA；
3. 冻结 P1-Pro in-process tenant context与 RLS/等价隔离；
4. 通过目标 PostgreSQL 镜像的 `pg_trgm` Spike，并用标注语料冻结 Recall@K/MRR 与延迟 SLO；
5. 冻结 Node/Content 两类响应 schema、服务端 Token hard cap 与 cursor 语义。
