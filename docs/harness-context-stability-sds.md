# Harness 运行时上下文稳定性与大结果治理 — SDS

> 状态：**v0.3（Revised Draft / 架构分层与模型视图规范）**
> 目标：确立“保留历史事实、替换模型视图”的上下文管理架构，解决超长对话上下文膨胀、中文 Token 估算失真、MCP 大结果无节制侵入模型上下文、以及超限崩溃问题。
> 适用运行时：Cloudflare Workers (CF) 与 Node.js self-host (main-node) 双运行时一致对齐。

---

## 1. 核心架构哲学：保留历史事实，替换模型视图

借鉴现代大模型长周期 Agent 架构（如 Codex / Responses API `context_management` 与 loss-aware compaction）：
**上下文治理的核心绝非“超限后粗暴删除旧消息（Truncation）”，而是通过严格的分层机制，在保证审计事实完整性的同时，动态生成精炼的模型上下文视图。**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. 不可变事件日志层 (Append-only Event Log - SQLite / Postgres)              │
│                                                                             │
│  [Event 1] user.message ("任务初始目标与核心约束...")                          │
│  [Event 2] agent.tool_use ("wiki_search")                                   │
│  [Event 3] agent.mcp_tool_result {                                          │
│              blob_ref: "blob_feishu_369k_sha256", // 持久 Blob 存储          │
│              byte_length: 369684,                                           │
│              preview: "..."                                                 │
│            }                                                                │
│  [Event 4] session.compaction_boundary (压缩检查点事件，记录状态摘要与 tail 范围)│
│  ...                                                                        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       │ 动态上下文投影 (Context Projection)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. 模型上下文投影层 (Model Context Projection - 动态生成，零破坏性改写)       │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ 1. 用户原始目标与全局约束 (User Goals & System Constraints)            │  │
│  ├───────────────────────────────────────────────────────────────────────┤  │
│  │ 2. 状态压缩检查点 (Compaction Checkpoint / State Summary)              │  │
│  │    • 已完成操作与阶段性结论                                            │  │
│  │    • 关键工具调用与外部系统状态                                        │  │
│  │    • 待解决问题与当前执行计划                                          │  │
│  ├───────────────────────────────────────────────────────────────────────┤  │
│  │ 3. 最近若干轮原文 (Preserved Verbatim Tail)                           │  │
│  │    • 最近 N 条消息的原汁原味上下文 (保持连贯推理能力)                  │  │
│  ├───────────────────────────────────────────────────────────────────────┤  │
│  │ 4. 当前轮 MCP 大结果投影 (MCP Big Result Guard)                        │  │
│  │    • 结构化预览 (前 3,000 字符) + 沙箱持久化路径 (/workspace/.mcp/...) │  │
│  │    • 引导 Agent 使用 read(offset, limit) 按需分段读取                  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼ Pre-flight 安全检查 (Token 估算 >= compact_threshold)
                     ┌─────────────────┴─────────────────┐
                     ▼                                   ▼
          达到阈值: 触发模型执行压缩           未达阈值: 直接发起 Agent 推理
         (POST /responses/compact 语义)                  │
                     │                                   │
                     └─────────────────┬─────────────────┘
                                       │
                                       ▼
                              ┌────────────────┐
                              │ Provider Call  │
                              └───────┬────────┘
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
                 Success                         400 Context Limit (最后保险)
                                                        │
                                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. 400 超限作为最后防线 (Emergency Re-compaction & Single Retry)            │
│                                                                             │
│  • 记录异常 Span：span.model_request_end { is_error: true, status: 400 }   │
│  • 绝不修改或删除已持久化的历史事件；                                       │
│  • 在投影层强制收敛 Tail 窗口并执行即时压缩重投影；                         │
│  • 生成新的 attempt 重试一次；若依然失败则记录完整错误并优雅进入 idle。      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 关键机制与分层规范

### 2.1 大结果治理在首入时拦截（Big Result Ingestion Guard）
**核心原则：Compaction 不能代替大结果治理；30 万字符的原始结果必须在首次进入模型上下文前就被拦截分流。**

1. **持久化与引用化（Ingestion Phase）**：
   - 当 MCP 工具（如 `docx_v1_document_rawContent`）返回内容超过阈值（`MAX_INLINE_RESULT_BYTES = 15KB`）：
   - 完整内容由底层 Blob 存储或沙箱持久化落盘：`/workspace/.mcp/<tool_name>_<call_id>.txt`（或持久 BlobStore）；
   - DB 中的 `agent.mcp_tool_result` 记录结构化结果，附带 `blob_ref`、`byte_length`、`sha256` 以及正文头部摘要。
2. **上下文投影（Projection Phase）**：
   - 投射到发往 LLM 的 `messages` 中的并非 36 万字符全文，而是标准化的结构化代理卡片：
     ```markdown
     [Tool Result: 369,684 chars - Stored to disk: /workspace/.mcp/feishu_docx_call123.txt]

     --- Content Preview (First 3,000 characters) ---
     <正文前 3000 字符>

     --- Usage Instructions ---
     The full document is available on disk. Use the `read` tool with line `offset` and `limit` to inspect specific sections as needed.
     ```

---

### 2.2 提前触发的主动模型压缩（Loss-aware Compaction）
**核心原则：在逼近窗口前主动由模型生成压缩检查点，而非被动等待 400 报错。**

1. **Token 估算器（基于 Unicode Code Point）**：
   - 采用 `for (const char of text)` 按 Code Point 遍历，杜绝 Emoji 等代理对重复统计；
   - 区分 CJK 统一表意文字（~1.25 tokens/字）、ASCII/英文（~0.25 tokens/字）、复杂符号与 Emoji（~2.0 tokens/字）；
   - 使用固定多语言测试集，与真实模型 API usage 进行误差标定（保持在 ±15% 以内）。
2. **触发时机（Pre-flight Check）**：
   - 每次模型请求前计算当前投影上下文预估 Tokens；
   - 结合模型实际配置的 `context_window_tokens`（例如 MiniMax M2.7 为 `204,800`，Claude 3.5 为 `200,000`，Claude 4.6 为 `1,000,000`，支持 ModelCard 覆盖）；
   - 当达到安全余量阈值（如 `compact_threshold = 0.70 ~ 0.75 * context_window`）时，**在发起正常 Agent 推理前，先发起一次模型压缩调用**。
3. **压缩检查点内容（Compaction Checkpoint）**：
   - 压缩调用聚焦提炼 5 大要素：
     1. 用户核心意图、范围与未完成约束；
     2. 已经完成的操作与确认的事实；
     3. 关键工具调用结果与外部系统状态；
     4. 当前阻塞点与未解决问题；
     5. 下一步具体执行步骤。
   - 压缩结果以 `session.compaction_boundary` 事件形式持久化追加到 Event Log 中；
   - 后续所有模型调用自动以该压缩检查点作为历史起点，仅拼接此后的 Preserved Tail 原文。

---

### 2.3 400 超限作为最后防线（Last-Resort Insurance）
若由于极端并发输入导致供应商仍然返回 400（`context window exceeds limit`）：
1. **语义规范**：视为单次 attempt 失败，不修改任何历史已落库事件；
2. **重试机制**：
   - 记录 `span.model_request_end { is_error: true, status: 400 }`；
   - 强制收紧 Preserved Tail 范围（由保留最近 5 轮收敛至仅保留最近 1 轮），并立即基于已有 Compaction 检查点生成极致紧凑视图；
   - 发起第二次重试（Retry Once）；
3. **终态处理**：若重试依然超限，写入包含具体错误详情的 `session.error`（带 `details: { provider_error: "..." }`），将选择权交给用户或上层系统。

---

## 3. 验收准则与 TDD 规范

1. **大结果首入治理测试**：
   - 模拟 MCP 工具产生 400KB 文本输出，断言：
     - 沙箱对应路径成功生成实体文件；
     - 投影给 LLM 的上下文消息严格控制在 4,000 字符内；
     - Agent 能够通过 `read` 工具按需读取该文件的指定行。
2. **主动压缩触发测试**：
   - 构造多轮中文对话达到 `compact_threshold`，断言：
     - 在正常推理前自动插入一次 Compaction 模型调用；
     - Event Log 成功写入 `session.compaction_boundary`；
     - 下一轮模型推理的输入 Tokens 相比压缩前大幅下降（>70%）。
3. **不变性测试**：
   - 无论发生主动压缩还是 400 应急重试，断言历史 `session_events` 表中的全部 `user.message`、`agent.tool_use`、`agent.mcp_tool_result` 记录未发生任何 UPDATE 或 DELETE 操作。
