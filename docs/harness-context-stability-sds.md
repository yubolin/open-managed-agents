# Harness 运行时上下文稳定性与大结果治理 — SDS

> 状态：**v0.1（Draft / 评审草案）**  
> 目标：解决超长对话上下文膨胀、中文 Token 严重低估、MCP 大结果无节制侵占上下文、模型超限崩溃与报错掩盖问题。  
> 适用运行时：Cloudflare Workers (CF) 与 Node.js self-host (main-node) 双运行时一致对齐。

---

## 1. 问题背景与事实核查

### 1.1 现状与复现事实（2026-08-22 实测回溯）
在真实生产会话中，Agent 读取飞书等外部 MCP 服务时，单次 `agent.mcp_tool_result` 携带了长达 **369,684 字符**、**148,370 字符**、**112,193 字符** 的原始文档全文。
这些大文本直接完整保留在会话事件历史中，导致：
1. **模型输入 Tokens 迅速膨胀至 228,198 tokens**，首 token 延迟达到 20.9s，单轮耗时超 70s；
2. **压缩机制（Compaction）零触发**（数据库记录 `compaction_events = 0`）；
3. **供应商报错崩溃**：MiniMax 返回 HTTP 400 `invalid params, context window exceeds limit (2013)`；
4. **前端错误被掩蔽**：UI 显示通用 `harness_turn_failed`，真实供应商错误码被隐藏。

### 1.2 根因定位

| # | 缺陷模块 | 源码位置 | 根因描述 |
|---|---|---|---|
| 1 | **Token 估算器** | `apps/agent/src/harness/compaction.ts:80`<br>`apps/agent/src/harness/default-loop.ts:921` | 硬编码 `Math.ceil(s.length / 4)`（假设 4 字符/Token）。对中文文本（1 汉字通常占用 0.6–1.5 tokens），导致估算值比真实值低 **2~3 倍**，从而完全无法达到 `0.75` 的压缩触发阈值。 |
| 2 | **模型窗口大小写敏感** | `apps/agent/src/harness/default-loop.ts:941` | `id.includes("MiniMax")` 区分大小写。实际传入 `minimax-m2.7` 时匹配失败，回落为默认 200K，且缺乏 ModelCard 自定义窗口大小配置通道。 |
| 3 | **MCP 结果无拦截外置** | `apps/agent/src/harness/tools.ts:1308-1411` | 现有 `web_fetch` 具备 `>5KB` 自动将正文写入 `/workspace/.web/<sha>.md` 并进行摘要外置的设计，但通用 MCP（`agent.mcp_tool_use` / `agent.mcp_tool_result`）缺少大结果拦截与外置机制。 |
| 4 | **缺乏超限应急熔断** | `apps/agent/src/harness/default-loop.ts` | 模型调用前无 Hard Guard，模型返回 400（Context Limit Exceeded）后无重试直接抛出致命异常，导致会话永久处于损坏状态。 |
| 5 | **错误详情丢失** | `apps/main-node/src/lib/node-session-router.ts:99` | 捕获底层错误时仅上报固定字面量 `harness_turn_failed`，丢失了 `err.message`、`provider_status` 及供应商原始响应体。 |

---

## 2. 系统设计与架构改进

```
                               ┌─────────────────────────────┐
                               │     MCP Tool Invocation     │
                               └──────────────┬──────────────┘
                                              │
                                              ▼
                              ┌───────────────────────────────┐
                              │  Result Size Guard (> 15KB?)  │
                              └───────┬───────────────┬───────┘
                        No (< 15KB)   │               │ Yes (>= 15KB)
                                      ▼               ▼
                        ┌──────────────────┐  ┌──────────────────────────────────┐
                        │ Return Verbatim  │  │ 1. Offload to Sandbox Disk:      │
                        │ to Event Log     │  │    /workspace/.mcp/<call_id>.txt │
                        │                  │  │ 2. Return Preview (3000 chars)   │
                        │                  │  │    + Read Instructions to Context│
                        └─────────┬────────┘  └────────────────┬─────────────────┘
                                  │                            │
                                  └────────────┬───────────────┘
                                               │
                                               ▼
                              ┌──────────────────────────────────┐
                              │ CJK-Aware Token Estimator        │
                              │ (Unicode Block Weighting)        │
                              └────────────────┬─────────────────┘
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         │                                           │
                         ▼                                           ▼
             Tokens > 0.75 * Window                        Tokens <= 0.75 * Window
             ┌────────────────────────┐                    ┌────────────────────────┐
             │ Trigger CC Compaction  │                    │ Direct Model Inference │
             └───────────┬────────────┘                    └───────────┬────────────┘
                         │                                             │
                         └─────────────────────┬───────────────────────┘
                                               │
                                               ▼
                               ┌───────────────────────────────┐
                               │  Model Call (with Fallback)   │
                               └───────────────┬───────────────┘
                                               │
                                      ┌────────┴────────┐
                                      ▼                 ▼
                                   Success          400 Exceeds Limit
                                                        │
                                                        ▼
                                       ┌──────────────────────────────────┐
                                       │ Emergency Drop-Oldest-Tools      │
                                       │ Sliding Window & Retry Once      │
                                       └──────────────────────────────────┘
```

---

## 3. 详细技术规范

### 3.1 CJK 感知的多字节 Token 估算器（`estimateMessageTokens`）

替换原有的天真 `length / 4` 算法，采用字符集区间分段权重统计（零外部依赖、高性能）：

```typescript
/**
 * CJK 感知的轻量 Token 估算器
 * - ASCII / 英文 / 标点 / 数字：约 0.25 tokens / char (4 字符 ≈ 1 token)
 * - CJK 统一表意文字 / 假名 / 谚文 / 全角标点：约 1.25 tokens / char
 * - 其他多字节 Unicode（Emoji / 特殊符号）：约 1.5 tokens / char
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherMultiByteCount = 0;
  let asciiCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7F) {
      asciiCount++;
    } else if (
      (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
      (code >= 0x3000 && code <= 0x303F) ||   // CJK Symbols and Punctuation
      (code >= 0xFF00 && code <= 0xFFEF) ||   // Halfwidth and Fullwidth Forms
      (code >= 0x3040 && code <= 0x309F) ||   // Hiragana
      (code >= 0x30A0 && code <= 0x30FF) ||   // Katakana
      (code >= 0xAC00 && code <= 0xD7AF)      // Hangul Syllables
    ) {
      cjkCount++;
    } else {
      otherMultiByteCount++;
    }
  }

  return Math.ceil(asciiCount * 0.25 + cjkCount * 1.25 + otherMultiByteCount * 1.5);
}
```

### 3.2 模型上下文窗口解析（`resolveContextWindowTokens`）

1. **大小写无关匹配与精准模型映射**：
   ```typescript
   export function resolveContextWindowTokens(model: LanguageModel, overrideLimit?: number): number {
     if (typeof overrideLimit === "number" && overrideLimit > 0) {
       return overrideLimit;
     }
     const rawId = (model as any)?.modelId ?? (typeof model === "string" ? model : "");
     const id = String(rawId).toLowerCase();
     
     if (id.includes("minimax-m2.7") || id.includes("minimax")) return 200_000;
     if (id.includes("claude-3-5-sonnet") || id.includes("claude-sonnet-4-6")) return 1_000_000;
     if (id.includes("claude-opus") || id.includes("claude-haiku")) return 200_000;
     if (id.includes("gpt-4o") || id.includes("qwen") || id.includes("deepseek")) return 128_000;
     
     return 128_000; // 安全保底默认值
   }
   ```
2. **ModelCard 配置通道支持**：
   在 `ModelCard` 模式定义中增加可选字段 `context_window_tokens`，通过 HarnessContext 向下透传。

### 3.3 MCP 大结果拦截与沙箱外置（Offloading Policy）

对所有外部 MCP 工具（`mcp__*`）返回的 Content 执行统一拦截策略：
- **阈值**：单个 Tool Result 文本长度超过 `MAX_INLINE_MCP_RESULT_BYTES = 15,360`（15 KB，约 3,000~5,000 tokens）；
- **外置写入**：
  - 若挂载有 Sandbox，将完整原始结果写入沙箱：`/workspace/.mcp/<tool_name>_<call_id>.txt`；
  - 返回给上下文的内容结构化替换为：
    ```markdown
    [MCP Tool Result Exceeded 15KB - Truncated for Context Stability]
    The full tool result (369,684 chars) was saved to disk: /workspace/.mcp/feishu_kb_docx_rawContent_call123.txt
    
    --- Preview (First 3,000 characters) ---
    <正文前 3000 字符>
    
    --- Instruction ---
    If you need specific sections, use the `read` tool with `offset` and `limit` to inspect the full file.
    ```
- **收益**：彻底消除单次工具调用膨胀 30 万字符打爆上下文的问题，将超大结果由“强制全量入上下文”转化为“按需分页检索”。

### 3.4 供应商 400 异常应急熔断与降级重试

在 `default-loop.ts` 的模型调用层增加 Catch 拦截：
```typescript
try {
  const result = await model.doGenerate(...);
} catch (err: any) {
  if (isContextWindowExceededError(err)) {
    // 1. 记录 warning 日志
    console.warn(`[Harness] Context window exceeded from provider. Triggering emergency sliding-window.`);
    // 2. 紧急丢弃历史中非最近一轮的大型 tool_result，替换为简要占位符
    messages = applyEmergencyToolResultCompaction(messages);
    // 3. 再次重试调用
    const retryResult = await model.doGenerate(...);
    return retryResult;
  }
  throw err;
}
```

### 3.5 错误详情透传机制

在 `node-session-router.ts` 与 `SessionRegistry` 中：
- 废除裸抛 `"harness_turn_failed"`；
- 包装为结构化错误负载：
  ```typescript
  {
    type: "session.error",
    error: "harness_turn_failed",
    message: err.message || "Model execution failed",
    details: {
      provider: modelProvider,
      status_code: err.status ?? 400,
      provider_error: err.data ?? err.message,
      estimated_tokens: currentTokens
    }
  }
  ```
- 前端控制台将 `details.provider_error` 呈现在错误卡片第一行。

---

## 4. 验收准则（TDD 测试矩阵）

1. **Token 估算器测试**：
   - 包含 10,000 纯中文字符的字符串，估算结果应在 `11,000 ~ 13,000` tokens 范围内（不再返回 2,500）；
   - 包含 10,000 英文单词的字符串，估算结果在 `2,500 ~ 3,500` tokens 范围内。
2. **MCP 大结果拦截测试**：
   - 构造 100KB 的 MCP tool_result，断言上下文消息体被截断至 3,000 字符预览，且生成 `/workspace/.mcp/*.txt` 实体文件。
3. **大小写无关匹配测试**：
   - 传入 `"minimax-m2.7"`、`"MiniMax-M2.5"`，断言均正确解析为对应窗口大小。
4. **紧急熔断重试测试**：
   - Mock 模型第一次抛出 400 Context Limit Exceeded，断言 Harness 触发紧急裁剪并在第二轮重试成功。
