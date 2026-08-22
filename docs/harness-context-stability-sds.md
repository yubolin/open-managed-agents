# Harness 运行时上下文稳定性与大结果治理 — SDS

> 状态：**v0.4（Revised Draft / No-go）**
>
> 范围：仅定义设计与验收边界；未获明确 go-ahead 前不进入 TDD 或代码实现。
>
> 目标：参考 OpenAI 面向长周期、工具密集工作流公开的 Responses API 上下文治理机制，为 OpenMA 建立 Provider 无关的“持久事实 + 有界模型视图 + 主动压缩 + 可恢复失败”架构。
>
> 适用运行时：Cloudflare Workers 与 Node.js self-host；两条路径必须通过同一组契约测试。

---

## 1. 事实基线与参考边界

### 1.1 已确认的生产问题

生产会话曾将 `369,684`、`148,370`、`112,193` 字符的飞书 MCP 原始结果直接带入模型上下文，模型输入增长至 `228,198 tokens`，随后 MiniMax 返回 HTTP 400：`context window exceeds limit (2013)`。该事件同时暴露出三类问题：

1. 大结果在第一次模型可见前没有被治理；
2. `length / 4` 对中文内容低估，且模型窗口依赖模型 ID 猜测；
3. Provider 的真实错误虽出现在模型请求 Span 中，但最终 UI 只显示通用错误。

### 1.2 OpenAI 官方公开机制

本 SDS 只引用公开、可验证的机制，不推断 Codex 客户端未公开的内部阈值或实现：

- Responses API 支持 `context_management` 与 `compact_threshold`；
- `POST /v1/responses/compact` 对已有上下文执行 loss-aware compaction，返回用于继续对话的 opaque compaction item；官方建议提前监控上下文，并在工具密集阶段或里程碑后压缩，而不是每轮压缩；
- `truncation: auto` 会从会话开头丢弃条目以适配窗口；`disabled` 会在超限时返回 400。该字段已标记 deprecated，因此 OpenMA 不把“自动丢最旧消息”作为主方案。

参考：

- [OpenAI Model guidance — Compaction](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)
- [OpenAI API — Compact a response](https://developers.openai.com/api/reference/java/resources/responses/methods/compact)
- [OpenAI API — Create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

### 1.3 OpenMA 的适配边界

OpenMA 不是仅服务 OpenAI Responses API 的客户端。MiniMax、Anthropic、OpenAI-compatible 等 Provider 未必支持原生 compact item，因此采用两层能力：

| 层级 | v0.4 决策 |
|---|---|
| Provider 无关基线 | 用现有 `agent.thread_context_compacted` 事件持久化可移植的语义检查点，并从事件日志派生有界模型视图 |
| Provider 原生增强 | 后续仅在 Provider 明确支持且适配器能保存/回放 opaque item 时启用；不能把 OpenAI `/responses/compact` 直接套到 MiniMax 或 Anthropic |

因此，文中“参考 Codex”指参考其公开 API 所体现的设计原则，不宣称复制 Codex 未公开的客户端实现。

---

## 2. 设计目标与非目标

### 2.1 设计目标

1. 单个 MCP/工具大结果不得未经投影就进入模型上下文；
2. 事件日志保持可审计、可重放，不因压缩或重试发生 UPDATE/DELETE；
3. 每次 Provider 调用前必须有可解释的输入预算与 Hard Guard；
4. 在到达窗口前主动压缩，压缩后保留任务状态和近期原文；
5. 仅对“确认是上下文超限且尚无外部副作用”的 attempt 自动恢复一次；
6. 错误详情能够从 Provider Span 关联到 `session.error` 和 Console。

### 2.2 非目标

- 不用 Compaction 替代飞书/RAG 的检索与分块；
- 不承诺用启发式估算器进行计费级 Token 统计；
- 不把 `/workspace` 当作持久存储或审计真相；
- 不在 SDS 中硬编码未经当前 Provider/Model Card 验证的模型窗口规格；
- 不通过静默删除旧用户指令来“修好”超限。

---

## 3. 核心不变量

### I1：事件日志是事实层

`user.message`、`agent.*tool_use`、`agent.*tool_result`、`agent.message` 和压缩边界均只追加。只有 DB/Event Log append 与必要的 Blob spill 都返回持久化确认后，结果才可进入模型投影。Cloudflare 现有 R2 spill 是 fire-and-forget，尚不构成该 durability barrier；这是 Phase A 必须补齐的实现差距。Node 运行时也必须提供等价的持久化确认。压缩不改变这些事件的事实语义。

### I2：模型上下文是派生视图

`eventsToMessages*`/`deriveModelContext` 输出的是可重新生成的模型视图，不是审计记录。大结果可以在模型视图中变成预览和引用，但事件原文仍可恢复。

### I3：`/workspace` 只是执行缓存

`/workspace/.mcp/<call_id>.txt` 可帮助 Agent 使用 `read(offset, limit)` 分段读取，但它可能随 Sandbox 生命周期丢失。文件必须能由持久事件内容或持久 Blob 重新物化；路径本身不能成为唯一 `blob_ref`。

### I4：工具协议必须闭合

无论结果如何投影，每个 `tool-call` 都必须保留一个相同 `toolCallId` 的 `tool-result`。不能为了省 Token 删除结果而制造 Provider 协议错误。

### I5：失败 attempt 不污染成功轨迹

重试必须使用新的 `attempt_id`/stream message ID；失败流先标记 aborted。已经执行的写操作或已提交的工具副作用不得因上下文错误自动重复。

---

## 4. 目标架构

```text
Tool/MCP raw result
        │
        ▼
┌──────────────────────────────┐
│ A. Durable fact ingestion    │  append full event / transparent blob spill
└──────────────┬───────────────┘
               │
               ├── optional materialization → /workspace/.mcp/<call_id>.txt
               │                              (rebuildable cache only)
               ▼
┌──────────────────────────────┐
│ B. Context planner           │  full result → bounded preview + durable event locator
│  - result admission budget   │
│  - checkpoint + verbatim tail│
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ C. Pre-flight token budget   │  system + tools + messages + output reserve
└──────────────┬───────────────┘
       below threshold │ above threshold
                       ▼
             portable checkpoint compaction
                       │ append agent.thread_context_compacted
                       ▼
                  re-derive + re-count
                       │
               hard limit satisfied?
                    │         │
                   yes        no → do not call Provider; structured failure
                    ▼
               Provider call
                    │
      success ───────┴──── confirmed context overflow
                              │ no output/tool side effect
                              ▼
                    emergency compact projection
                         + one new attempt
```

一个 `ContextPlanner` 必须同时服务正常推理和压缩调用。禁止出现“正常调用使用有界视图，但压缩调用重新发送完整 36 万字符历史”的双轨实现。

---

## 5. 详细设计

### 5.1 大结果首入治理

结果先完整追加到事件日志，再生成模型投影。建议的默认预算以 Token 为主、Byte 为兜底，最终值须经真实 Provider 标定：

```text
usable_input_tokens = context_window_tokens
                    - max_output_tokens
                    - protocol_reserve_tokens

per_result_inline_budget = min(8_192, 5% * usable_input_tokens)
aggregate_tool_result_budget = 20% * usable_input_tokens
```

超过预算的文本结果投影为：

```json
{
  "status": "externalized",
  "tool_call_id": "call_123",
  "content_type": "text/plain",
  "byte_length": 369684,
  "sha256": "...",
  "preview": "按 token 预算截取的头部与尾部预览",
  "source_event_id": "sevt_123",
  "source_event_seq": 456,
  "persistent_blob_ref": "event-log spill reference, optional",
  "workspace_path": "/workspace/.mcp/call_123.txt",
  "workspace_path_durability": "ephemeral_rebuildable"
}
```

约束：

- `preview` 按 Token 预算截取，不再使用“前 3,000 字符”等对 CJK 不稳定的规则；
- 头尾都保留，避免只保留文档开头而丢失结论或错误栈末尾；
- 结构化 JSON 必须仍作为原工具调用的合法 Tool Result 返回；
- `source_event_id`/`source_event_seq` 是稳定恢复定位符；`persistent_blob_ref` 只在 Event Log 实际 spill 时存在，客户端不得自行拼接；
- 重物化流程必须按当前 session/tenant 重新授权，读取原事件或其透明 spill，校验 `sha256` 后原子写入 workspace；
- 如果无法写入 workspace，仍返回预览与 `materialization_error`，不得把全文回退注入模型；
- 若持久原文也无法落库，本次工具结果必须失败为 `tool_result_persistence_failed`，不得假装成功。

### 5.2 Token 计量与窗口来源

计量优先级：

1. Provider 官方 count-tokens/input-tokens API（若可用且延迟可接受）；
2. 与具体模型绑定且版本已验证的 tokenizer；
3. 经多语言样本标定的保守估算器，并使用 P95 低估修正系数。

启发式估算必须覆盖 system、tool schemas、messages、图片/文档占位和 Provider 包装开销；不能只统计消息正文。

窗口来源优先级：

1. Model Card 显式字段 `context_window_tokens`；
2. Provider adapter 的精确模型版本表；
3. 安全默认值，并记录 `window_source=default_unverified` 告警。

当前 `ModelCardRow` 尚无 `context_window_tokens`，所以实现前必须先完成 schema、API、Console 与双运行时迁移。不得继续用 `id.includes("MiniMax")` 一类宽泛匹配作为最终方案。若 Phase A 先行，则采用 fail-closed 临时规则：Model Card 未显式配置窗口且 adapter 无精确版本记录时，禁止启用自动预算治理下的模型调用，并返回 `context_window_unknown`；不得用未经验证的宽泛默认值继续请求。

### 5.3 主动压缩与检查点

默认策略采用滞回控制，避免每轮重复压缩：

- 触发线：预计输入达到 `usable_input_tokens` 的 70%；
- 压缩目标：压缩后不高于 35%；
- 触发后只有新增上下文再次越过触发线才允许下一次自动压缩；
- 工具密集阶段完成、阶段性目标完成时可触发里程碑压缩，但仍须经过冷却检查。

检查点复用现有 `agent.thread_context_compacted`，不引入不存在的 `session.compaction_boundary`。事件至少保存：

- `summary`：可移植的任务状态摘要；
- `replaced_range`：被摘要覆盖的事件 seq 范围；
- `original_message_count`、`compacted_message_count`、`pre_tokens`；
- `trigger`：自动或人工触发。

摘要必须覆盖：用户目标与不可违反的约束、已确认事实与证据、已完成操作、外部系统状态、未完成事项、阻塞点、下一步。ContextPlanner 必须先按事件边界选择完整 Tail，再令 `replaced_range.end_seq < tail_start_seq`，只将 `replaced_range` 交给摘要模型。Tail 边界不得拆开 tool-call/result 对，避免摘要与 Tail 重复或形成无结果的 tool call。

若摘要为空、被截断、产生 tool call、或压缩后仍未达到目标预算，则不写有效边界，并进入受控失败；不得像当前 best-effort 路径一样继续把已知超限的全文提交给 Provider。

### 5.4 Provider 原生 Compaction 能力

定义两类可选能力接口，而不是把 Provider-native 输入强行还原为通用 `ModelMessage[]`，也不在 Harness 中硬编码 OpenAI URL：

```typescript
interface PortableContextAdapter {
  compact(input: ContextProjection, budget: ContextBudget): Promise<PortableSummaryArtifact>;
  restore(artifact: PortableSummaryArtifact, tail: ModelMessage[]): ModelMessage[];
}

interface ProviderNativeContextAdapter<TRequestInput> {
  compact(input: TRequestInput, budget: ContextBudget): Promise<NativeCompactionArtifact>;
  buildProviderInput(artifact: NativeCompactionArtifact, tail: ModelMessage[]): TRequestInput;
}

type NativeCompactionArtifact = {
  kind: "provider_native";
  provider: string;
  api_family: string;
  model: string;
  opaque_payload: unknown;
};
```

- v0.4 基线实现 `portable_summary`；
- OpenAI Responses adapter 后续可保存 opaque compaction item，但该 item 只能由相同 `provider + api_family + compatible model` 的 adapter 回放，不能解析其内部内容；
- Provider/模型不支持时必须回退到 portable summary，而不是模拟一个假的 opaque item。

### 5.5 Hard Guard 与超限恢复

正常调用前：

1. 生成最终投影；
2. 重新计量；
3. 若仍超过 `usable_input_tokens`，不调用 Provider，返回 `context_projection_exceeds_budget`；
4. 错误详情列出 system、tools、history、tail、current tool results、output reserve 各自预算，便于定位。

Provider 已返回错误时，只有同时满足以下条件才自动恢复一次：

- HTTP 状态、Provider error code/message 被分类器确认是 context overflow；
- 失败的 Provider request attempt 满足：`stream_bytes_emitted = 0`、`canonical_events_committed = 0`、`tool_execution_started = 0`；
- 本轮尚未执行过 overflow retry。

恢复动作为：记录失败 Span → abort 当前 stream → 缩小 Tail 并强制生成紧凑投影 → Hard Guard 复检 → 使用新 `attempt_id` 重试一次。重试只重发失败的模型请求，复用此前已持久化的 Tool Result，绝不重新执行工具。若已有任何 text delta、partial tool input、canonical event 或工具执行，则不自动重试。任一条件不满足或第二次失败，都写结构化 `session.error` 并回到 idle，不无限重试。

### 5.6 错误关联与 Console 呈现

`span.model_request_start/end`、retry 和 `session.error` 共享 `request_id`/`attempt_id`。Console 通过 ID 关联，不再依赖“在 `session.error` 之前向后寻找最近 Span”的脆弱时序。

建议错误结构：

```json
{
  "code": "provider_context_window_exceeded",
  "message": "模型上下文超过窗口限制",
  "retryable": false,
  "details": {
    "provider": "minimax",
    "provider_status": 400,
    "provider_code": 2013,
    "provider_message": "context window exceeds limit",
    "estimated_input_tokens": 228198,
    "context_window_tokens": 204800,
    "attempt_id": "attempt_02"
  }
}
```

`provider_message` 必须脱敏后展示；通用 `harness_turn_failed` 只能作为最外层兜底，不能覆盖根因。

---

## 6. 与现有实现的差距

| 位置 | 当前事实 | v0.4 要求 |
|---|---|---|
| `apps/agent/src/harness/compaction.ts` | 以 `length / 4` 估算；summarize 仍可能发送完整上下文 | 共享 ContextPlanner；多层计量；压缩调用也使用有界视图 |
| `apps/agent/src/harness/default-loop.ts` | 模型窗口按 ID 字符串猜测；压缩失败后继续主调用 | Model Card/adapter 精确窗口；失败后 Hard Guard，不盲送 |
| `apps/agent/src/runtime/history.ts` | 已支持 `agent.thread_context_compacted` + Tail | 增加大 Tool Result 的确定性投影与可重物化引用 |
| `apps/agent/src/harness/tools.ts` | 内建工具有字符截断；MCP 结果无统一外置层 | 统一 Tool/MCP result admission policy |
| `packages/event-log` | CF 有 R2 spill；Node 使用自己的 Event Log | 明确双运行时大事件持久化与恢复契约 |
| Model Card store/API/Console | 无 `context_window_tokens` | 加字段、校验、迁移、审计来源 |
| Node session router / Console projector | 错误关联依赖事件时序 | 用 request/attempt ID 结构化关联 |

---

## 7. 分阶段落地

### Phase A：先止血

- 为 Event Log append/Blob spill 增加可等待的 durability barrier；
- MCP/Tool 大结果首次进入模型前进行有界投影；
- 引入最终调用 Hard Guard；
- 要求 Model Card 显式窗口或 adapter 精确版本记录；未知窗口 fail closed；
- 修复 Provider 错误透传与 Console 展示；
- 用生产失败会话的脱敏事件夹具做回放测试。

### Phase B：稳定压缩

- Model Card 增加显式窗口；
- 引入共享 ContextPlanner 与标定后的计量器；
- 修正 portable checkpoint 的摘要范围、Tail 和滞回策略；
- 补齐 attempt/retry 事件关联。

### Phase C：Provider 原生增强

- 仅对实际支持的 OpenAI Responses adapter 接入 native compaction；
- 对成本、延迟、压缩质量与 portable summary 做 A/B；
- 不改变其他 Provider 的基线行为。

---

## 8. TDD 与验收门槛

### 8.1 单元与属性测试

- CJK、ASCII、Emoji、JSON tool schema、多模态占位的计量误差，按 Provider/模型统计 P50/P95；
- 任意事件序列经大结果投影后，tool call/result ID 仍闭合；
- 同一事件日志重复派生得到字节一致的模型视图；
- 压缩前后事件日志无 UPDATE/DELETE；
- `/workspace` 丢失后可从持久事实重新物化大结果。
- Blob spill 写失败、DB 成功但 Blob 未确认、进程在 ack 前退出时，结果不得进入模型投影；
- 摘要 `replaced_range` 与 Tail seq 不重叠，且边界不拆开 tool-call/result；
- native artifact 在错误 Provider/API family/model 上回放必须被拒绝。

### 8.2 场景测试

使用生产问题的脱敏回放夹具：

1. 注入 369KB + 148KB + 112KB 的 MCP 结果；
2. 断言三份原文都可从事件事实层恢复；
3. 断言第一次 Provider 可见内容已经是有界投影；
4. 断言任何 Provider 调用的输入均不超过 Hard Guard；
5. 断言压缩后任务约束、关键文档引用、当前计划仍能被模型回答；
6. 模拟一次 overflow，断言最多重试一次且使用新 attempt；
7. 模拟已产生 tool call 后再报错，断言不自动重放副作用。
8. 模拟 partial text/partial tool input，断言不自动重试；模拟此前只读或写工具已完成，断言恢复只重发模型请求并复用已持久 Tool Result，工具执行次数不增加；
9. 捕获实际 Provider request body，证明首次可见的大结果已经是投影，而不仅是内部派生对象满足预算。

### 8.3 双运行时与真实 Provider 验收

- CF 与 Node 运行同一契约测试；
- 至少覆盖当前生产 MiniMax 和一个 Anthropic/OpenAI 模型；
- 真实 Provider 验证前，mock/fixture 通过只能标记“本地验证”，不能将 SDS 升为 Ready；
- 观察指标：首 Token 延迟、总耗时、压缩次数、压缩前后 Tokens、外置结果数、overflow 次数、retry 成功率、错误根因展示率。

---

## 9. Go/No-go 条件

当前结论：**No-go for implementation**。进入 TDD 前必须确认：

1. Model Card 新字段及默认值策略；
2. Node 大事件的持久化上限与恢复实现；
3. 默认 Token 预算和真实模型标定样本；
4. attempt/request ID 的事件 schema 变更；
5. Phase A 是否允许先于完整 native compaction 独立上线。
