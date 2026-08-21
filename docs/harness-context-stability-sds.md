# Harness 运行时上下文稳定性与大结果治理 — SDS

> 状态：**v0.2（Revised Draft / 架构与语义规范）**
> 目标：解决超长对话上下文膨胀、中文 Token 严重低估、MCP 大结果无节制侵占上下文、模型超限崩溃与报错掩盖问题。
> 适用运行时：Cloudflare Workers (CF) 与 Node.js self-host (main-node) 双运行时一致对齐。

---

## 1. 问题背景与事实核查

### 1.1 生产复现事实（2026-08-22 实测回溯）
在真实生产会话中，Agent 读取飞书等外部 MCP 服务时，单次 `agent.mcp_tool_result` 携带了长达 **369,684 字符**、**148,370 字符**、**112,193 字符** 的原始文档全文。
这些大文本直接保留在会话中，导致：
1. **模型输入 Tokens 迅速膨胀至 228,198 tokens**，首 token 延迟达到 20.9s，单轮耗时超 70s；
2. **压缩机制（Compaction）零触发**（数据库记录 `compaction_events = 0`）；
3. **供应商报错崩溃**：MiniMax 返回 HTTP 400 `invalid params, context window exceeds limit (2013)`；
4. **前端错误被掩蔽**：UI 显示通用 `harness_turn_failed`，真实供应商错误码被隐藏。

### 1.2 根因定位与事实校准

| # | 缺陷模块 | 源码位置 | 根因描述与校准 |
|---|---|---|---|
| 1 | **Token 估算器** | `apps/agent/src/harness/compaction.ts:80`<br>`apps/agent/src/harness/default-loop.ts:921` | 硬编码 `Math.ceil(s.length / 4)`。中文文本（1 汉字通常占用 0.6–1.5 tokens）被低估 2~3 倍；且 `charCodeAt` 遇到 Emoji 等双字节代理对会重复统计。 |
| 2 | **模型窗口大小写与规格校准** | `apps/agent/src/harness/default-loop.ts:941` | `id.includes("MiniMax")` 区分大小写，`minimax-m2.7` 匹配失败回落为 200K。官方真实规格：MiniMax M2.7 窗口上限为 **204,800 tokens**；Claude 3.5 Sonnet 为 **200,000 tokens**，仅 Claude 4.6+ 为 1M。 |
| 3 | **大结果未做投影分层** | `apps/agent/src/harness/tools.ts:1308-1411` | 现有 `web_fetch` 具备 `>5KB` 写入 `/workspace/.web/<sha>.md` 并进行摘要外置，但通用 MCP 缺少大结果拦截与外置投影机制。 |
| 4 | **缺乏超限应急滑窗重试** | `apps/agent/src/harness/default-loop.ts` | 模型调用前无 Hard Guard，模型返回 400（Context Limit Exceeded）后直接抛出异常导致会话报废。 |
| 5 | **错误详情丢失与事件时序** | `apps/main-node/src/lib/node-session-router.ts:99` | 捕获底层错误时仅上报固定字面量 `harness_turn_failed`，且 `session.error` 先于 `span.model_request_end` 落库导致前端投影错位。 |

---

## 2. 核心架构决策：持久事件原文 vs 模型上下文投影

OpenMA 平台的核心不变量是：**事件日志（Event Log）是不可变的审计账本，而模型上下文（Model Context）是按需生成的动态投影视图**。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. 持久事件原文层 (Persistent Event Log Layer - Immutable SQLite/PG)         │
│                                                                             │
│  [Event 250] user.message ("读取文档")                                       │
│  [Event 251] agent.mcp_tool_use ("docx_rawContent")                          │
│  [Event 252] agent.mcp_tool_result (完整原始 369,684 字符，落库保真审计)       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ eventsToMessages(events) 动态投影
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. 模型上下文投影层 (Model Context Projection Layer - Ephemeral / Compacted)│
│                                                                             │
│  • CJK-Aware Token Estimator 准确评估总 Tokens                               │
│  • Result Size Guard 拦截超大结果（>15KB）：                                │
│    - 沙箱落盘：/workspace/.mcp/<call_id>.txt                                │
│    - 投影上下文：前 3,000 字符预览 + read 工具按行分页读取指引               │
│  • Compaction Trigger：总 Tokens > 0.75 * Window 时自动触发 CC Summarize     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼ 发起 LLM 推理
                              ┌────────────────┐
                              │ Provider Call  │
                              └───────┬────────┘
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
                 Success                         400 Context Limit
                                                        │
                                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. 应急降级与重试语义 (Emergency Sliding Projection & Event Semantics)       │
│                                                                             │
│  a. 记录失败 Span：span.model_request_end { is_error: true, status: 400 }   │
│  b. 不修改历史事件，向当前投影应用 Emergency Sliding Window：                │
│     将非最新一轮历史 Tool Result 折叠为简短占位摘要                           │
│  c. 发起第二次模型重试（Retry Once）                                         │
│  d. 成功 → 继续正常 Agent Loop；失败 → 记录带完整 detail 的 session.error     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 详细技术规范

### 3.1 CJK 感知的 Unicode Code Point Token 估算器

使用 `for (const char of text)` 按 Unicode Code Point 迭代（避免代理对计算两次）：

```typescript
/**
 * CJK 感知的轻量 Token 估算器（基于 Unicode Code Point）
 * - ASCII / 英文 / 数字 / 标点 (codePoint <= 127): 约 0.25 tokens / char
 * - CJK 表意字符 / 假名 / 谚文 / 全角标点: 约 1.25 tokens / char
 * - 复杂 Emoji / 补充平面符号 (codePoint > 0xFFFF): 约 2.0 tokens / char
 * - 其他多字节 Unicode: 约 1.5 tokens / char
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let asciiCount = 0;
  let cjkCount = 0;
  let emojiCount = 0;
  let otherCount = 0;

  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp <= 0x7F) {
      asciiCount++;
    } else if (
      (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs
      (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
      (cp >= 0x20000 && cp <= 0x2A6DF) || // CJK Extension B
      (cp >= 0x3000 && cp <= 0x303F) ||   // CJK Symbols & Punctuation
      (cp >= 0xFF00 && cp <= 0xFFEF) ||   // Halfwidth & Fullwidth Forms
      (cp >= 0x3040 && cp <= 0x309F) ||   // Hiragana
      (cp >= 0x30A0 && cp <= 0x30FF) ||   // Katakana
      (cp >= 0xAC00 && cp <= 0xD7AF)      // Hangul Syllables
    ) {
      cjkCount++;
    } else if (cp > 0xFFFF) {
      emojiCount++;
    } else {
      otherCount++;
    }
  }

  return Math.ceil(asciiCount * 0.25 + cjkCount * 1.25 + emojiCount * 2.0 + otherCount * 1.5);
}
```

### 3.2 模型上下文窗口映射表（精确规格校准）

```typescript
/**
 * 精确映射各大模型的官方上下文窗口规格（Tokens）。
 * 优先级：ModelCard.context_window_tokens 显式配置 > 官方模型 ID 精确匹配 > 保底 128,000。
 */
export function resolveContextWindowTokens(model: LanguageModel | string, overrideLimit?: number): number {
  if (typeof overrideLimit === "number" && overrideLimit > 0) {
    return overrideLimit;
  }
  const rawId = (model as any)?.modelId ?? (typeof model === "string" ? model : "");
  const id = String(rawId).toLowerCase();

  // MiniMax 官方规格
  if (id.includes("minimax-m2.7") || id.includes("minimax-m2.5") || id.includes("minimax")) return 204_800;

  // Anthropic 官方规格（严谨区分版本）
  if (id.includes("claude-sonnet-4-6") || id.includes("claude-opus-4-6") || id.includes("claude-opus-4-7")) return 1_000_000;
  if (id.includes("claude-3-5-sonnet") || id.includes("claude-3-7-sonnet") || id.includes("claude-3-5-haiku")) return 200_000;
  if (id.includes("claude-3-opus") || id.includes("claude-3-sonnet") || id.includes("claude-3-haiku")) return 200_000;

  // OpenAI / DeepSeek / Qwen
  if (id.includes("gpt-4o") || id.includes("gpt-4.5") || id.includes("o1") || id.includes("o3")) return 128_000;
  if (id.includes("deepseek-v3") || id.includes("deepseek-r1")) return 128_000;
  if (id.includes("qwen-2.5") || id.includes("qwen-max")) return 128_000;

  return 128_000; // 安全兜底
}
```

### 3.3 MCP 大结果沙箱外置与动态投影策略

- **持久层**：`agent.mcp_tool_result` 保持完整原文记录在 DB（保证回溯与审计）；
- **投影层（`eventsToMessages`）**：
  - 当单个 Tool Result 长度超过 `MAX_INLINE_MCP_RESULT_BYTES = 15,360`（15KB）：
  - 自动向沙箱写入 `/workspace/.mcp/<tool_name>_<call_id>.txt`；
  - 投射到 LLM 上下文的内容为：
    ```markdown
    [Tool Result Exceeded 15KB - Saved to sandbox disk: /workspace/.mcp/feishu_kb_docx_rawContent_call123.txt]
    
    --- Preview (First 3,000 characters) ---
    <正文前 3000 字符>
    
    --- Guidance ---
    The document is 369,684 characters long. If you need specific sections, use the `read` tool with `offset` and `limit` to inspect specific lines of the file.
    ```

### 3.4 应急重试的事件语义与时序修复

1. **时序与错误结构规范**：
   - 抛出异常时，先写入 `span.model_request_end`（携带 `provider_status: 400`, `error_message: "invalid params, context window exceeds limit (2013)"`）；
   - 随后写入 `session.error`，其 `message` 与 `details` 包含结构化字段，彻底终结掩蔽现象。
2. **应急滑窗重试（1 次）**：
   - 触发 400 时向日志记录 `span.model_retry`；
   - 将除最近一轮之外的所有历史 `tool_result` 内容动态替换为 `[Tool result folded to recover context window]`；
   - 重新估算并重试一次模型调用。

---

## 4. 验收准则与 TDD 标定

1. **Token 估算器标定测试**：
   - 构造包含 10,000 个汉字 + 标点的固定语料，断言估算值落在 MiniMax / Claude 实际 API 返回 `model_usage.input_tokens` 的 **±15% 误差区间内**；
   - 构造包含 10,000 个 ASCII 字符的固定语料，断言估算值落在 `2,300 ~ 2,700` tokens 范围内；
   - 构造包含 500 个复杂 Emoji（如 👨‍👩‍👧‍👦、🎯）的语料，断言估算值正常且不抛出范围异常。
2. **大结果投影测试**：
   - DB 存入 300KB 的 `agent.mcp_tool_result`，断言 `eventsToMessages()` 产生的 `ModelMessage` 文本长度不超过 3,500 字符，且沙箱对应路径存在该完整文件。
3. **上下文超限重试测试**：
   - Mock 供应商首次返回 400 `context window exceeds limit`，断言 Harness 触发一次滑窗裁剪并在第二轮调用成功完成 turn。
