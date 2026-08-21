# Agent 自助安装 Skill — 小型 SDS/TDD（实施前置）

> 状态：v0.2 已批准（2026-08-20 owner 拍板 §5 评审门五题，见 §5 答案列）。
> 上下文：owner 截图诊断 (a) 调错工具 (b) 假搜索结果 (c) Session 漂移。
> 作用：颗粒度对齐 owner 列举的 7 方面（工具权限/用户确认/版本固定/供应链校验/Agent 版本更新/新 Session 接续/CF-Node 能力边界），**作为后续实施的 Go 闸**。
> 不做什么：不重写 `self-install-sds.md` v0.1 12 项安全要求；那是 v0.2 → Green 的全集，本 SDS 是 v0.2 的"agent 自助"切片。

---

## 1. 闭环流程（owner 截图的"理想交互"版）

```
用户：有哪些可用的运维 skill？
    ↓
search_skill (只读, always_allow, tenant scope)
    ↓ ClawHub verified tier 实时查询
展示：真实结果（slug, version, owner, summary, sha256, size）
    ↓
用户：安装 deployment-kit@1.0.3 到当前 Agent
    ↓
install_skill (always_ask + confirmation_token, 平台主进程代签 fetch)
    ↓ 写 R2 + KV + 写 skill_versions.hash
attach_skill (always_ask + confirmation_token + 强制 version 显式)
    ↓ PUT /v1/agents/:id with If-Match etag + skills[]
工具返回 { new_session_required: true }
    ↓
agent 引导用户："绑定到当前 Agent 后需要新 Session 才生效"
    ↓
新 Session（agent_snapshot 固化 skills[], Runtime 读快照）
    ↓
首次消息 system prompt 已含 <skill name="deployment-kit">...</skill>
```

**两条硬约束（owner 明确边界）**：

| 约束 | 实现位置 | 验证 |
|------|---------|------|
| Agent **不可在当前 Session 热插拔** Skill | attach_skill 工具返回 `new_session_required: true` | E2E: attach 后旧 Session snapshot 不变 |
| Agent **不持有** OMA_API_KEY / 控制面 token | `ctx.env.SKILL_RPC.fetch(...)` service binding | grep + runtime env 验证 |

---

## 2. 七方面实施前置要求

### 2.1 工具权限（三档）

| 工具 | 权限 | tenant scope | 必填 | 实现位置 |
|------|------|-------------|------|---------|
| `search_skill` | `always_allow` | ✓ | `q?` | `apps/agent/src/harness/tools.ts` 新增 |
| `install_skill` | `always_ask` + `confirmation_token` | ✓ | `slug`, `version`（禁 latest）| 同上 |
| `attach_skill` | `always_ask` + `confirmation_token` | ✓ | `agent_id`, `skill_id`, `version` | 同上 |
| `detach_skill` | `always_ask` + `confirmation_token` | ✓ | `agent_id`, `skill_id` | 同上 |
| `uninstall_skill` | `always_ask` + `confirmation_token` | ✓ | `skill_id`, `version` | 同上 |

**验收**：SDS v0.2 review checklist §1.1-1.6 全过。

### 2.2 用户确认（confirmation_token）

| 项 | 规则 |
|----|------|
| 生成方 | 工具被调用时由前端 / Console 弹窗生成 |
| 验证 | 后端工具入口校验 token 一次性使用，TTL 60s |
| 失败 | 403 "confirmation required or expired" |
| admin 白名单 | `OMA_SKILL_ADMIN_ALLOWLIST`（运营账号）可 bypass |

**验收**：单测 + 集成测拒绝无 token 调用，token 二次使用 → 403。

### 2.3 版本固定（已 9e01541 落地一部分）

✅ **已实施 (commit 9e01541)**：
- `POST /v1/clawhub/install` 强制 `version` 必填
- 拒绝 `version: "latest"`
- CLI 升级为 `oma skills install <slug> <version>`

⏳ **待实施**：
- `attach_skill` 工具 schema 强制 `version` 非空
- Agent.skills 数组每项 `version` 必填（缺则 reject）
- 自动 resolve `latest_version` → 必须显式调用方传

### 2.4 供应链校验

| 项 | 实现 |
|----|------|
| 包来源 | 仅 ClawHub verified tier + owner 自托管白名单 URL |
| 白名单 URL 配置 | `OMA_SKILL_WHITELIST_URLS` env var |
| 校验时机 | `install_skill` 工具入口 |
| 失败 | 403 "package source not in whitelist" |
| 哈希写 | `install_skill` 成功后写 `skill_versions.hash` (sha256) |
| 哈希校验 | `attach_skill` 工具读 hash，调用方传 hash 必须一致 |

**验收**：单测（未 verified 包 → 403、未白名单 URL → 403、hash 不一致 → 409）。

### 2.5 Agent 版本更新（optimistic concurrency）

| 项 | 规则 |
|----|------|
| `PUT /v1/agents/:id` | 必须带 `If-Match: <etag>` |
| 冲突 | 409，body 含最新 etag |
| 客户端 | 读最新后重试或放弃 |
| 工具 retry | `attach_skill` / `detach_skill` 内部自动 retry-once |

**验收**：单测（缺 etag → 428 / 不匹配 → 409 / retry-once 路径）。

### 2.6 新 Session 接续（Session 不漂移）

| 项 | 规则 |
|----|------|
| `attach_skill` 返回 | `{ new_session_required: true, skill_id, version }` |
| 客户端行为 | 提示用户"已绑定到新版 Agent，需新 Session 生效" |
| 旧 Session | snapshot **不变**（runtime 仍读 frozen snapshot） |
| 新 Session 创建 | `POST /v1/sessions` 带 `agent_id`，snapshot 立即含新 skills |
| 验证 | 旧 Session 重新读 `agent_snapshot.skills` 与 attach 前一致 |

**验收**：E2E（smoke SOP §7：attach 后旧 Session 无 diff）+ 集成测（new Session 第一条消息 system prompt 含 `<skill name=...>`）。

### 2.7 Cloudflare / Node 能力边界

**双 lane 约定（2026-08-21 更新）**：Node 的 skill 写入有两条通道——
1. **RPC 工具通道**（agent 会话内 `install_skill`/`attach_skill` → `createNodeSkillRpc`，2c3dca5）：**放行**，custom 类型经 confirmation guard + store 层 `agents.update` 落库（不经过 HTTP 路由的 F7 门）。
2. **HTTP 直写通道**（Console/SDK 调 `PUT /v1/agents/:id` 携带 `skills[].type==="custom"`）：**维持 501 `{runtime:"node"}`**（F7）——Node 上 Console 编辑 custom skill 仍显式拒绝。

**Node 读路径（2026-08-21 落地）**：SessionRegistry.build() 现按 CF session-do.ts:4417-4489 对齐——frozen agent snapshot 的 skills 解析为 `skill:<id>` platform reminders（custom 的 SKILL.md 经 `<skill name>` 内联，字节级同 CF）+ 沙箱挂载 skill 文件（workdir 相对 `.skills/<name>/`，CF 为 microVM 内 `/home/user/.skills`）。skill KV 由 InMemoryKvStore 换 SqlKvStore（安装元数据重启不丢）。

| Runtime | search | install (RPC) | attach (RPC) | HTTP 直写 custom | 读路径（注入+挂载） |
|---------|--------|---------|--------|------|------|
| CF | ✅ | ✅ | ✅ | ✅ | ✅（`/home/user/.skills`）|
| Node | ✅ (2c3dca5) | ✅ (2c3dca5) | ✅ (2c3dca5) | ❌ 501（F7）| ✅（2026-08-21，`.skills/`）|

**已知缺口（记录在案，未在本切片处理）**：
- `registerSkill` 全仓无调用方：builtin 技能（xlsx/pptx/pdf/docx）在**两个运行时**都不注入 prompt——resolveSkills 恒空。需产品决策 builtin 注册的归属（seed 脚本 vs 启动注册）。
- Node `runSubAgent` 子代理路径 `platformReminders: []` 硬编码：子代理无 skill/memory reminders（既有债，先于本切片）。
- Node 未处理 `agent.appendable_prompts`（CF 在 reminders 最前注入）。
- F9 端到端 smoke 仍待服务器部署 + P2 操作员 key。

**已实施 (commit 31eb117)**：Node 5 个 stub endpoint 改 501 显式拒绝。

⏳ **待实施**：
- `attach_skill` 在 Node 走 agents 路由时，**检测 `skills[].type === "custom"` → 501**（✅ 已落为 F7；SDK 区分 501/200-empty/404 已落为 F8）

---

## 3. 实施分片（v0.2 → Go 的最小切片）

| 切片 | 范围 | 依赖 | 验收 |
|------|------|------|------|
| **F1** ✅ | 强制 version 必填 + 禁 latest | 无 | 9e01541（已 commit + push）|
| **F2** ✅ | `search_skill` 工具 schema（only CF 实现）| F1 | 单测 6/6 + 回归（apps/main 17/17、schedule 16/16、clawhub 4/4）；E2E smoke 归 F9（984ed88）|
| **F3** ✅ | `install_skill` 工具 + 供应链门（env 门控 `OMA_SKILL_REQUIRE_VERIFIED`，owner 2026-08-20 默认关）+ sha256 写入 skillver manifest | F1, F2 | lib 单测 8/8 + 路由 4/4 + agent 工具 6/6；lib/route/SkillRpc 三方同源（lib/clawhub.ts）|
| **F4** ✅ | `attach_skill` 工具 + optimistic concurrency（复用 agent 行 `version` 作 etag，retry-once）+ always_ask + `new_session_required` + hash 复验（不一致→409） | F1, F3 | lib 单测 12/12 + 工具 6/6；smoke §6.2-6.4 归 F9 |
| **F5** ✅ | confirmation_token 全链路：lib（64-hex 单次 + TTL 60s + purpose 绑定 + admin bypass）→ mint 路由 `POST /v1/skills/confirmation` → SkillRpc 双入口 guard（403）→ `user.tool_confirmation.confirmation_token` 事件穿透 → Console SkillApprovalCard（Approve 时铸造）| F3, F4 | lib 单测 12/12 + token 穿透 7/7 + 回归 49/49；E2E 归 F9 |
| **F6** ✅ | Agent etag 协议：`PUT /v1/agents/:id` 缺 `version` → 428 Precondition Required；stale → 409（body 含最新 etag）；HTTP-lane 契约单测 3/3（retry-once 已在 F4 lib 落地）| F4 | 单测 3/3（159a4be）|
| **F7** ✅ | Node `attach_skill` custom 类型 → 501：共享 agents 路由加 `allowCustomSkills` 能力门，Node 挂载传 false，create/update 携带 `skills[].type==="custom"` → 501 `{runtime:"node"}`；CF 不传（放行）| F4 | 单测 4/4（80d8fa4）|
| **F8** ✅ | Client 区分 501 / 200-empty / 404：Console `isNotImplementedError` + `NotImplementedNotice`（SkillsList/RuntimesList 501 → 显式提示，不再渲染空列表；心跳轮询遇错自停）；SDK 导出 `isOpenMANotImplemented`（OpenMAError 自带 status+body）；CLI 已打印 501 原文无需改 | F1 | Console 44/44（含 7 新）+ SDK 3/3 + tsc/build 绿（5fbab7c）|
| **F9** ⏳ | 端到端 smoke (smoke-test-sop §6) | F2-F5 | E2E pass |

---

## 4. 风险与回退

| 风险 | 触发 | 回退 |
|------|------|------|
| **热插拔被误开启** | `attach_skill` 未返回 `new_session_required` | E2E 旧 Session diff 必须空，否则 revert F4 |
| **OMA_API_KEY 泄露到 sandbox** | 工具实现走 `fetch(${OMA_BASE_URL}...)` | grep + runtime env 双重检查 |
| **假搜索结果** | `search_skill` 走缓存 / mock | F2 必须实时调 ClawHub verified tier |
| **hash 不匹配但 attach 成功** | 哈希校验路径未生效 | 单测 + 集成测断言 |

---

## 5. 评审门（owner 已拍板 2026-08-20，闸开 → F2 放行）

| 项 | 答案 |
|----|------|
| F1 已实施内容认可？ | **Y** — 认可保留（9e01541 留在 GitLab） |
| F2-F9 切片颗粒度接受？ | **Y** — 接受（每片独立可回滚） |
| 工具命名 | **`search_skill` 单数**（对齐 `registerSkill` 现有接口 + `web_search` 惯例；install/attach/detach/uninstall_skill 全组单数一致） |
| confirmation_token UI 位置 | **Console 弹窗**（SDK confirm() 后续补） |
| 白名单 URL 配置载体 | **env var `OMA_SKILL_WHITELIST_URLS`**（与 `OMA_SKILL_ADMIN_ALLOWLIST` 同模式） |

---

## 附录 A：与现有 docs 的关系

- `self-install-sds.md` v0.1 — 12 项安全要求全集（**不重写**）
- `sds-v0.2-review-checklist.md` — 12 项验收门（**直接引用**）
- `runtime-capabilities.md` §3 — Node 静默假阳性（**已修 31eb117**）
- `smoke-test-sop.md` §6 — 端到端 4 项验证（**F9 必跑**）
- `operator-runbook.md` — 操作员执行手册（**F5/F9 配套**）

## 附录 B：owner 截图诊断的三层问题

| 层 | 问题 | 解决 |
|----|------|------|
| 1 | Agent 调错工具（用 web_search 搜 ClawHub）| F2 `search_skill` 工具 |
| 2 | 搜索失败仍给"参考 Skill" | F2 + 强约束：search 返回空 → 工具返回 `[]` + 系统 prompt 引导"无可用 Skill" |
| 3 | install ≠ 绑定 + 既有 Session 不生效 | F4 `attach_skill` + `new_session_required` |
