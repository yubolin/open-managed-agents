# 飞书知识库搜索能力演进 — P1 SDS

> 状态：**v0.1（Draft / 选型与架构草案）**  
> 来源：基于生产使用中“用户期望按关键词检索知识库，而 P0 只能枚举节点和阅读全文”的痛点演进。  
> 定位：在 P0 指定知识空间浏览直达连接器的基础上，构建**低延迟、高召回、具备权限隔离的飞书知识库检索能力**。

---

## 1. 痛点与现状分析

### 1.1 P0 的能力边界与问题
在当前 P0 连接器实现中（详见 [feishu-kb-p0-sds.md](file:///Users/bolin/Documents/git/openma/docs/integrations/feishu-kb-p0-sds.md)）：
- 仅提供 4 个只读工具：`wiki_v2_space_list`、`wiki_v2_spaceNode_list`、`wiki_v2_space_getNode`、`docx_v1_document_rawContent`；
- **无关键词搜索接口**。
- **Agent 在搜索任务下的被动行为**：
  1. 递归枚举空间下的所有节点目录；
  2. 靠模型自行猜测可能命中的文档标题；
  3. 读取多篇文档的完整全文到上下文，通过 LLM “阅读理解”来回答。
- **后果**：单轮触发 7 次以上 MCP 工具与 8 次串行模型推理，耗时高达 70+ 秒，引发 22.8 万 Token 上下文膨胀，且容易遗漏深层子节点中的文档。

---

## 2. 技术方案对比与选型评估

针对飞书知识库的检索需求，我们对业界与平台现状下的三种方案进行全面评估：

| 评估维度 | 方案 A：用户 OAuth 原生搜索 | 方案 B：应用身份本地索引 + 混合检索 (推荐 P1) | 方案 C：MCP 内存并发标题/元数据搜索 (P1-Lite) |
|---|---|---|---|
| **核心机制** | 引入用户 OAuth 凭证，调用官方 `wiki.v1.node.search` 与 `docx.builtin.search` | 由系统/Worker 周期性拉取已授权 Space 文档，在本地 Postgres (pg_trgm/FTS) 或向量库建立索引，暴露本地 `search` 工具 | 在 `oma-lark-mcp` sidecar 内部实现高并发 Space 节点遍历树缓存，提供秒级标题/路径模糊匹配 |
| **搜索能力** | 飞书全功能正文与节点搜索 | 支持关键词 BM25 精确匹配 + 语义向量召回 + 段落级别精准定位 | 支持节点标题、路径名模糊搜索（不支持大正文全文深搜） |
| **凭证与身份** | 需要用户身份（`user_access_token`） | 维持现有应用身份（`tenant_access_token`），零权限扩散 | 维持现有应用身份（`tenant_access_token`），零权限扩散 |
| **技术复杂度** | 🔴 **极高**（Docker 容器无法交互式 OAuth，需自研 Token 轮转与代理注入，多租户改造深） | 🟡 **中等**（利用已有 Postgres 数据库建立 FTS/向量表，开箱即用） | 🟢 **极低**（仅在 sidecar 内增加并发缓存逻辑，1 天即可闭环） |
| **实时性** | 实时（即刻反映飞书变动） | 近实时（由增量同步或主动触发更新） | 内存缓存（TTL 5-10 分钟自动刷新） |
| **飞书权限隔离** | 由飞书服务端自动按用户权限过滤 | 仅能检索被授予给该 App 的空间/文档（物理隔离） | 仅能检索被授予给该 App 的空间/文档（物理隔离） |

---

## 3. 推荐演进路线：两阶段落地

### 阶段一（P1-Lite 即时见效）：MCP 空间节点树快速索引与标题检索
为 `oma-lark-mcp` 补充一个高并发空间树检索工具：`mcp__feishu-kb__wiki_search_nodes`。
- **原理**：sidecar 内部维护 LRU / TTL（10分钟）的空间节点树索引，收到检索请求后并发分页遍历，毫秒级返回匹配的节点列表（包含 `node_token`、`title`、`obj_token`、`parent_path`）。
- **工具定义**：
  ```json
  {
    "name": "wiki_search_nodes",
    "description": "Search wiki nodes and documents by keyword/title across accessible knowledge spaces",
    "parameters": {
      "query": { "type": "string", "description": "Keyword to search in document titles and node paths" },
      "space_id": { "type": "string", "description": "Optional: limit search to a specific space" }
    }
  }
  ```
- **收益**：Agent 搜索关键词时，仅需 1 次工具调用（耗时 <500ms）即可定位到目标文档的 `node_token`，再精准读取该文档，彻底消除递归遍历。

### 阶段二（P1-Pro 深度检索）：应用级文档切片与 BM25 + 向量混合检索（RAG）
- **架构设计**：
  ```
  ┌─────────────────────────────────────────────────────────────┐
  │ Background Sync Worker (Node / Cron)                       │
  │ 1. 扫描已授权 Space & Docx                                  │
  │ 2. 提取正文并进行 Chunking (500-1000 字符切片)               │
  │ 3. 写入 Postgres (tsvector + pgvector 嵌入向量)             │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Local Search MCP: mcp__feishu-kb__search_content            │
  │ 1. 接收 Agent query                                         │
  │ 2. 执行 BM25 关键词匹配 + 向量相似度混合重排 (RRF)           │
  │ 3. 返回 Top-K 文本片段（附带来源 doc_id / 标题 / 链接）     │
  └─────────────────────────────────────────────────────────────┘
  ```
- **核心优势**：
  1. **正文级精准命中**：直接返回最相关的 2~3 个正文段落（几百 tokens），Agent 无需再读取几十万字文档全文；
  2. **毫秒级响应**：本地数据库查询响应 <50ms；
  3. **架构闭环**：结合《Harness 上下文治理》，从输入源头根治上下文膨胀。

---

## 4. 权限与安全原则

1. **强租户隔离**：所有本地存储的切片与索引必须带有 `tenant_id` 与 `space_id` 复合主键，禁止跨租户召回；
2. **写隔离保持不变**：新增搜索工具依然严格限制在只读范围，Dockerfile CMD 维持 `-t` 白名单锁定；
3. **敏感凭证不出容器**：搜索索引的构建与调用均通过 `oma-server` / 内网 sidecar 内部流转，飞书凭证保持在 `/run/secrets/`。

---

## 5. 验收与评测准则

1. **检索延时指标**：关键词搜索耗时由目前 >70s 降低至 **< 1.5s**；
2. **Token 消耗指标**：一次典型知识库检索对话，模型上下文输入降低 **80% 以上**（从 200k+ 下降至 <10k tokens）；
3. **召回率指标**：在包含 100+ 篇文档的知识空间中，搜索业务关键词（如“租户级记忆”、“部署手册”）能在 Top-3 准确召回目标节点。
