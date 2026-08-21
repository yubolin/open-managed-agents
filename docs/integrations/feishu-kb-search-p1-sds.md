# 飞书知识库搜索能力演进 — P1 SDS

> 状态：**v0.2（Revised Draft / 架构选型与部署拓扑）**
> 来源：基于生产使用中“用户期望按关键词检索知识库，而 P0 只能枚举节点和阅读全文”的痛点演进。
> 定位：在 P0 指定知识空间浏览直达连接器（见 [feishu-kb-p0-sds.md](./feishu-kb-p0-sds.md)）的基础上，构建**低延迟、高召回、具备强租户权限隔离的飞书知识库检索能力**。

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
拓扑 A：Sidecar 内存并发空间树缓存与标题搜索 (P1-Lite)
───────────────────────────────────────────────────────────────────────────────

  ┌──────────────┐ Streamable HTTP ┌────────────────────────┐ tenant_token ┌─────────────┐
  │  oma-server  │ ───────────────▶│  oma-lark-mcp           │ ────────────▶│ open.feishu │
  │ (main-node)  │  /mcp (内网)     │  • 内存并发 Space 树缓存 │              │  .cn /apis   │
  └──────────────┘                 │  • 暴露 wiki_search     │              └─────────────┘
                                   └────────────────────────┘
  • 部署位置：oma-lark-mcp 容器内部
  • 凭证来源：/run/secrets/lark-mcp-config（Docker secret）
  • 租户边界：由该 Sidecar 绑定的单一 AppID 物理锁定，零跨租户风险

───────────────────────────────────────────────────────────────────────────────
拓扑 B：平台级全文本地 RAG 搜索 (P1-Pro)
───────────────────────────────────────────────────────────────────────────────

  ┌───────────────────────────────────────────────────────────────────────────┐
  │ oma-server (apps/main-node)                                               │
  │                                                                           │
  │  1. In-process Tool: search_feishu_kb(query, space_id?)                   │
  │  2. Background Sync Worker: 定时拉取 docx 正文切片入库                    │
  │  3. 数据库检索:                                                            │
  │     • PostgreSQL 原生全文检索: tsvector + tsquery + ts_rank_cd            │
  │     • 可选向量检索: pgvector 扩展 (需 pgvector/pgvector 专用镜像)          │
  └─────────────────────────────────────┬─────────────────────────────────────┘
                                        │
                                        ▼ SQL 物理隔离
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ PostgreSQL (oma 数据库)                                                    │
  │ 表: feishu_kb_chunks                                                      │
  │ 主键/约束: (tenant_id, space_id, doc_token, chunk_index)                  │
  │ 索引: CREATE INDEX ON feishu_kb_chunks USING GIN(to_tsvector('simple',...))│
  └───────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 技术方案深度对比与选型评估

| 评估维度 | 方案 A：用户 OAuth 原生搜索 | 方案 B：Sidecar 空间树并发检索 (拓扑 A, P1-Lite) | 方案 C：平台级 PG 全文与向量检索 (拓扑 B, P1-Pro) |
|---|---|---|---|
| **核心机制** | 引入用户 OAuth 凭证，调用官方 `wiki.v1.node.search` 与 `docx.builtin.search` | 在 `oma-lark-mcp` Sidecar 内维护内存 Space 树缓存（TTL 10min），收到 query 后并发分级匹配节点标题与路径 | `oma-server` 后台 Worker 增量分块入库，利用 PostgreSQL 原生 `tsvector/ts_rank_cd`（及可选 `pgvector`）执行混合检索 |
| **搜索粒度** | 飞书官方全功能正文与节点搜索 | 节点标题、路径名模糊搜索（精准直达 node_token） | 文档段落级（Chunk-level）正文深搜与语义召回 |
| **凭证与身份** | 需要用户身份（`user_access_token`） | 维持现有应用身份（`tenant_access_token`），零权限扩散 | 维持现有应用身份（`tenant_access_token`），零权限扩散 |
| **技术复杂度** | 🔴 **极高**（Docker 容器无法交互式 OAuth，需自研 Token 轮转与代理注入，多租户改造深） | 🟢 **极低**（仅在 sidecar 内部增加并发缓存与匹配逻辑，1 天内闭环） | 🟡 **中等**（利用已有 Postgres 数据库原生 FTS 能力，无需外部向量服务即可启动） |
| **数据库要求** | 无本地存储要求 | 纯内存缓存，无额外 DB 要求 | 原生 PG 即可使用 FTS；若启用向量需 `pgvector` 扩展支持 |
| **飞书权限隔离** | 由飞书服务端自动按用户权限过滤 | 仅能检索被授予给该 App 的空间/文档（物理隔离） | 强租户隔离：SQL 显式带 `tenant_id` 过滤 |

---

## 4. 推荐演进路线与工具定义

### 4.1 阶段一（P1-Lite 即时见效）：Sidecar 空间树快速索引与标题检索
为 `oma-lark-mcp` 补充高并发空间树检索工具：`mcp__feishu-kb__wiki_search_nodes`。
- **工具定义**：
  ```json
  {
    "name": "wiki_search_nodes",
    "description": "Fast search wiki nodes and documents by title/path across authorized knowledge spaces",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Keyword to search in document titles and node paths" },
        "space_id": { "type": "string", "description": "Optional: limit search to a specific space" }
      },
      "required": ["query"]
    }
  }
  ```
- **执行收益**：Agent 搜索关键词时，仅需 1 次工具调用（耗时 <500ms）即可定位到目标文档的 `node_token`，再精准读取该文档，彻底消除目录递归遍历。

### 4.2 阶段二（P1-Pro 深度检索）：平台级文档切片与 PG 全文/混合检索
- **数据表设计**：
  ```sql
  CREATE TABLE feishu_kb_chunks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    doc_token TEXT NOT NULL,
    title TEXT NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
    updated_at BIGINT NOT NULL,
    CONSTRAINT uq_chunk UNIQUE (tenant_id, doc_token, chunk_index)
  );
  CREATE INDEX idx_kb_chunks_tsv ON feishu_kb_chunks USING GIN(tsv);
  CREATE INDEX idx_kb_chunks_tenant ON feishu_kb_chunks (tenant_id, space_id);
  ```
- **执行收益**：直接返回最相关的 2~3 个正文段落（几百 tokens），Agent 无需再将数十万字文档全文读入上下文。

---

## 5. 验收准则与 TDD 规范

1. **P1-Lite 检索延时与准确率**：
   - 在包含 100+ 节点的空间中搜索关键词，`wiki_search_nodes` 响应时间 `< 800ms`；
   - 能够精准返回包含关键词的节点 `node_token`、`title` 与 `parent_path`。
2. **多租户数据隔离测试**：
   - 租户 A 与租户 B 分别搜索时，断言任何检索结果均严格限制在请求携带的 `tenant_id` 范围内，绝无跨租户数据泄露。
