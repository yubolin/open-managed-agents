# Skill 自助安装 SDS

> 状态：v0.1（评审草稿，2026-08-20）· **No-go（待 v0.2 解决控制面凭据 / 生命周期 / Runtime 不一致 / 供应链四项硬约束后重审）**。
> 评审史：v0.1 由 owner 评审判定 No-go（控制面 API Key 暴露给 sandbox；install ≠ 绑定；Session snapshot 不漂移；Runtime 不一致；ClawHub 缺供应链防护）。
> 上游：2026-08-20 owner 评审 + `smoke-test-sop.md`（人工端到端验证）。
> 证据说明：§ file:line 来自 2026-08-20 第二轮评审与本仓库源码。

---

## 1. 真实缺口（对齐现状）

| # | 缺口 | 现状证据 |
|---|------|---------|
| G1 **P0** | 控制面凭据无 sandbox 隔离；将 OMA_API_KEY 注入 sandbox 等于授予 Agent 全控制面 | `tools.ts:344` / `session-do.ts:4562` / `main-node/index.ts:587` 均无 key 注入，**反向证明当前设计正确**，任何改造必须维持此隔离 |
| G2 **P1** | `POST /v1/clawhub/install` 只导入租户 Skill 库，不绑定 Agent；Console 必须二次把 skill_id 写入 Agent.skills | `clawhub.ts:40-98` 仅写 R2 + KV；`SkillsList.tsx:579` 显式提示用户 `"skills": [{type:"custom", skill_id:"...", version:"latest"}]`；`AgentFormDialog.tsx:1817` 为绑定 UI |
| G3 **P1** | Session 创建时固化 `agent_snapshot`，Runtime 优先读快照；任何 Agent 更新不回灌既有 Session | `sessions/index.ts:469/486` 写入快照；`session-do.ts:400` Runtime 优先读快照 |
| G4 **P1** | CF Runtime 已解析 / 挂载 Skill；Node Runtime `/v1/skills` 是 stub（`data: []`）、system prompt 不解析 Skill | `apps/main-node/src/index.ts:1031` stub；`apps/main-node/src/index.ts:601` 不解析 Skill |
| G5 **P1** | ClawHub 安装链路无 ZIP bomb / 路径穿越 / 重复安装防护；普通 Skill 上传链路已有 | `skills.ts:319-321` 100MB / 25MB / 500 文件上限；`clawhub.ts:104-156` 自写简易 zip parser，**无任何限制** |

**不是**"agent 不够聪明"、**不是**"需要对话内自识别"、**也不是**"marketplace 包不够多"。

---

## 2. 非目标

- 不做"对话内无痕安装"——所有写操作必须 `always_ask`
- 不重写 Skill 解析（`harness/skills.ts`）—— 仅补齐挂载前后的元数据与校验
- 不动 Anthropic `BUILTIN_SKILLS`（`apps/main/src/routes/skills.ts:76-117`）
- 不做 Skill marketplace 商业化、付费、版本市场拍卖
- 不解决 AIOps 数字员工的"假运维 skill"问题（`scripts/seed-aiops-digital-employees.ts:78-89`），那是另一份 SDS 的范围
- 不解决 Node Runtime 整体能力缺失——SDS 仅声明**功能门控**，实施由 Node 路线图承担

---

## 3. 现况（正确版）

### 3.1 三条 Skill 写入入口（已存在，行为各异）

| 入口 | API | 行为 | 缺什么 |
|------|-----|------|--------|
| 上传 .zip | `POST /v1/skills/upload`（`skills.ts:555-608`）| 全量 zip + 校验 | 缺版本自动递增 |
| JSON 形式 | `POST /v1/skills`（`skills.ts:534-548`）| 文件清单 | 缺原子事务 |
| 市场安装 | `POST /v1/clawhub/install`（`clawhub.ts:40-98`）| 下载 + 解压 + R2 + KV | 缺供应链防护（G5） |

### 3.2 Agent ↔ Skill 绑定现状

- Agent 表有 `skills` 字段（JSON 数组）
- Console 二次绑定 UI 已在 `AgentFormDialog.tsx:1813-1822`
- 写入路径：`PUT /v1/agents/:id`（具体行号待 v0.2 落实）
- 缺：optimistic concurrency、版本强制显式

### 3.3 Session 快照生命周期（基线）

参考 `p0-version-snapshot-sds.md` §3.4：
- **build 态**：Session 已创建但 Runtime 尚未初始化（合法集成期）
- **frozen 态**：Runtime 已初始化后，写入 `agent_snapshot` 不应再变

本 SDS **不重做**快照机制，只规定"attach Skill 必须在 build 态之前完成"，frozen 后必须新建 Session。

### 3.4 CF / Node 差异（必须门控）

| 维度 | Cloudflare Runtime | Node Runtime |
|------|-------------------|--------------|
| `/v1/skills` 实现 | 完整（`apps/main/src/routes/skills.ts`）| stub（`apps/main-node/src/index.ts:1031`）|
| Skill 解析 | 完整（`apps/agent/src/harness/skills.ts:46` `resolveCustomSkills`）| 无 |
| Skill 挂载 | `session-do.ts:4402-4471` 写 `~/.skills/<name>/` | 无 |

---

## 4. 设计（owner 12 项要求 + 颗粒度对齐）

### 4.A 工具权限三档（基础）

| 工具 | 操作 | 默认权限 | tenant scope | 必填字段 |
|------|------|---------|-------------|---------|
| `search_skill` | 只读 marketplace / tenant 已装 | `always_allow` | ✓ | `q?` |
| `install_skill` | 写入 R2 + KV | **`always_ask`** | ✓ | `slug`, `version`（**禁空**） |
| `attach_skill` | 修改 Agent.skills | **`always_ask`** | ✓ | `agent_id`, `skill_id`, `version` |
| `detach_skill` | 删除 Agent.skills 项 | **`always_ask`** | ✓ | `agent_id`, `skill_id`, `version` |
| `uninstall_skill` | 删除 R2 + KV | **`always_ask`** | ✓ | `skill_id`, `version` |

- `version` 字段**禁止**默认 `"latest"`；如省略 → 400 错误
- 所有写操作必须有确认 ID（`confirmation_token`），由工具生成、前端展示、用户确认后调用方能完成
- 工具实现走 service binding（§4.B），不直接让 LLM 调 HTTP

### 4.B 平台内部身份传递（控制面隔离）

**禁止**：
- ❌ 把 `OMA_API_KEY` 注入 sandbox 环境变量
- ❌ 把 `OMA_API_KEY` 注入工具入参
- ❌ 让 LLM 看到任何能调 `/v1/*` 的密钥

**必须**：
- ✅ 平台主进程持有凭据；agent 调 `install_skill` 时由 service binding 在主进程内完成 HTTP 调用
- ✅ agent 调 `attach_skill` 时由 service binding 调 `PUT /v1/agents/:id`，agent 只看到成功/失败结果
- ✅ sandbox 内的 bash 工具如需查询 marketplace，走 `web_fetch` + 公开 API（仅返回元数据，不返回下载链接之外的密钥）

实现参考：参考 Cloudflare service binding pattern（`apps/main/src/routes/integrations.ts:75` `installProxyFor` 已是同类模式）。

### 4.C 包来源白名单 + 版本锁定 + 哈希

| 项 | 规则 |
|-----|------|
| 包来源 | 仅允许：① ClawHub verified tier；② owner 自托管（白名单 URL） |
| 版本 | API 必须接受显式 `version`；不接受 `"latest"` 作为 install 入参 |
| 哈希 | 每次 install 后将 sha256(zip bytes) 写入 `skill_versions.hash` |
| 校验 | attach 时比对 `skill_versions.hash`；不匹配 → 拒绝 |

### 4.D ZIP bomb / 路径穿越 / 重复安装（复用已有防护）

- **总解压上限** 100 MB（参考 `skills.ts:319`）
- **单文件上限** 25 MB（参考 `skills.ts:320`）
- **文件数上限** 500（参考 `skills.ts:321`）
- **路径穿越**：拒绝 `../`、绝对路径、`\` 分隔符
- **必须存在** `SKILL.md`（否则 400）
- **重复安装**：同 `(tenant_id, skill_id, version)` 已存在 → 幂等返回 200，不重写 R2

实现：把 `apps/main/src/routes/skills.ts:325-385` 的 `parseSkillZipBytes` 抽出为 `lib/skill-zip.ts`，`clawhub.ts` 复用同一函数。

### 4.E tenant isolation + 审计 + 配额

| 项 | 规则 |
|-----|------|
| tenant scope | 所有 skill 操作 KV key 必须以 `t:{tenant_id}:` 前缀 |
| 审计事件 | `skill.install` / `skill.attach` / `skill.detach` / `skill.uninstall` 全部落审计表 |
| 配额 | 每 tenant：skills ≤ 200、累计存储 ≤ 500 MB、install 频次 ≤ 100/h |

### 4.F 卸载与回滚

```
detach_skill → uninstall_skill（两步，不可一步）
              ↓
        校验无 Agent 引用
              ↓
        删除 R2 + KV
              ↓
        失败 → 标记 skill 为 "tombstoned"，保留 30 天可恢复
```

attach 失败回滚（§4.J 原子事务的一部分）。

### 4.G CF / Node 一致能力或功能门控

- **功能门控**：Node Runtime 上所有写工具返回 `501 Not Implemented in this runtime`，**不静默失败**
- **能力矩阵文档**：`docs/runtime-capabilities.md`（v0.2 新增）记录每个工具在每个 Runtime 的支持状态
- **客户端显式展示**：Console / SDK 调用前显示 "This runtime does not support skill install"

### 4.H Session 不漂移（build vs frozen）

- **build 态**：Session 已创建但 Runtime 未初始化 → attach 合法
- **frozen 态**：Runtime 已初始化 → attach **不**回灌既有 Session
- **强制规则**：attach 必须返回 `{new_session_required: true}`，由调用方决定新建 Session
- 实现参考：`p0-version-snapshot-sds.md` §3.4 已有 build/frozen 边界

### 4.I Agent 更新用 optimistic concurrency

- `PUT /v1/agents/:id` 必须带 `If-Match: <etag>` 或 `version: <n>`
- 冲突 → 409 Conflict，body 含最新 etag
- 客户端必须读取最新后重试或放弃
- 工具 `attach_skill` / `detach_skill` 内部自动 retry-once

### 4.J 失败不留"已安装但未绑定"半完成状态

**两阶段事务**：
```
阶段 1（dry-run）：
  install_skill 预检（不写 R2/KV）
  attach_skill 预检（不改 Agent.skills）
  校验全过 → 返回 "ready_to_commit"

阶段 2（commit）：
  install_skill 真写 R2/KV
  attach_skill 真改 Agent.skills
  任一失败 → 全部回滚
```

实现：`install_skill` 与 `attach_skill` 工具实现必须支持 `commit=true|false` 参数。

### 4.K 默认 `always_ask`

- 写工具（install / attach / detach / uninstall）默认 `always_ask`
- 不允许运营账号直接 `always_allow`，除非 `admin_allowlist` 显式加入
- 白名单变更需要审计

### 4.L 不向 sandbox 暴露 OMA API Key 或平台 token

- sandbox env 中不能有 `OMA_API_KEY` / `OMA_*_TOKEN` / 类似命名的密钥
- 工具实现不把任何密钥拼入 LLM 可见的入参或结果字符串
- 验证（§5.1）：部署后 `oma runtimes exec <id> 'env | grep -i oma'` 必须为空

---

## 5. 验收门（按 SDS 要求验证）

### 5.1 凭据隔离

```bash
oma runtimes exec <sandbox_id> 'env | grep -i oma'
# 期望：stdout 为空
```

### 5.2 生命周期

```bash
# 同 smoke-test-sop.md §7：attach 后旧 Session 无 diff
diff before.json after.json
# 期望：空
```

### 5.3 Runtime 一致性

| Runtime | search | install | attach | 期望 |
|---------|--------|---------|--------|------|
| CF | 200 | 200 (with confirmation) | 200 (with confirmation) | 全支持 |
| Node | 200 | 501 | 501 | 显式拒绝，不静默 |

### 5.4 供应链

- 上传含 `../etc/passwd` 的 zip → 400
- 上传 1KB 但声明 10GB 的 zip → 400
- 上传无 `SKILL.md` 的 zip → 400

### 5.5 原子性

- 故意让 attach 失败 → install 自动回滚（KV/R2 无新条目）

### 5.6 审计事件

- 每个写操作 → 审计表新增一行，含 `tenant_id, actor, action, target, version, timestamp`

---

## 6. 实施阶段（按风险递增）

| 阶段 | 范围 | 退出条件 |
|------|------|---------|
| 6.0 smoke test | 用 `smoke-test-sop.md` 验证链路 | §1 baseline + §6 6.1-6.4 + §7 全过 |
| 6.1 阶段 2 search_skill | 只读工具，默认 allow | §5.3 CF/Node 行为符合 |
| 6.2 install_skill | 写工具 + 哈希 + 审计 + 复用 zip 防护 | §5.4 + §5.6 |
| 6.3 attach_skill | 写工具 + optimistic concurrency + always_ask | §5.2 + §5.5 |
| 6.4 uninstall + 配额 | detach + uninstall + tenant 配额 | §5.6 |
| 6.5 Node 门控 | Node Runtime 显式返回 501 | §5.3 Node 行 |
| 6.6 文档 | `docs/runtime-capabilities.md` + 工具参考 | 完成 |

---

## 7. 风险与回退

| 风险 | 触发条件 | 回退动作 |
|------|---------|---------|
| 控制面凭据泄露 | §5.1 非空 | 立刻 revoke API key，重启所有 sandbox，审计 |
| Session 漂移 | §5.2 非空 | 回滚 Agent.skills，回滚新 Session，禁止继续 |
| Runtime 静默失败 | §5.3 Node 行为不符 | 暂停 6.5 之前的发布，强制 Node 显式 501 |
| ZIP bomb 绕过 | §5.4 任一未拦截 | 立即停 ClawHub 入口，复用 `parseSkillZipBytes` |
| 原子性破坏 | §5.5 失败 | 回滚所有未 commit 操作，加 redo log |

---

## 附录 A：Runtime 类型判定（前置）

操作员**必须**在执行任何写操作前确认：

| 信号 | 判定 |
|------|------|
| 部署用 `wrangler deploy`，KV/R2 binding 在 `wrangler.toml` | Cloudflare |
| 部署用 `node dist/main-node/index.js`，数据库是 Postgres | Node |
| 部署用 `docker compose`，含 `apps/main-node` 服务 | Node |
| 不确定 | **停下来确认**，不要假定 |

`117.72.219.106` 实际部署属于哪一类，**待 owner 提供信息**——本 SDS 不假定。

---

## 附录 B：12 项要求 ↔ 本 SDS 章节

| Owner 要求 | 本 SDS |
|-----------|--------|
| 三档工具（search/install/attach）默认权限 | §4.A |
| 平台内部身份传递，不向 sandbox 暴露 API Key | §4.B + §4.L |
| 包来源白名单 + 版本锁定 + 哈希 | §4.C |
| ZIP bomb / 路径穿越 / 重复安装 | §4.D |
| tenant isolation + 审计 + 配额 | §4.E |
| 卸载与回滚 | §4.F |
| CF/Node 一致能力或功能门控 | §4.G |
| Session 不漂移（build vs frozen） | §4.H |
| Agent 更新 optimistic concurrency | §4.I |
| 失败不留半完成状态 | §4.J |
| 默认 always_ask | §4.K |
| 不暴露平台 token | §4.B + §4.L |

---

## 附录 C：相关引用

- `apps/main/src/routes/clawhub.ts:40-98` install 端点
- `apps/main/src/routes/skills.ts:76-117` BUILTIN_SKILLS
- `apps/main/src/routes/skills.ts:319-321` ZIP bomb 防护上限
- `apps/main/src/routes/skills.ts:325-385` parseSkillZipBytes（待抽 `lib/skill-zip.ts`）
- `apps/main/src/routes/skills.ts:534-548` POST /v1/skills
- `apps/main/src/routes/skills.ts:555-608` POST /v1/skills/upload
- `apps/agent/src/harness/skills.ts:46` resolveCustomSkills（KV/R2 解析）
- `apps/agent/src/harness/skills.ts:24` registerSkill（生产路径零调用）
- `apps/agent/src/harness/tools.ts:26` DEFAULT_TOOLS
- `apps/agent/src/harness/tools.ts:308-313` tools: [] 等价 defaultSet
- `apps/agent/src/harness/tools.ts:344` 无 key 注入证据
- `apps/agent/src/runtime/session-do.ts:400` Runtime 优先读 snapshot
- `apps/agent/src/runtime/session-do.ts:4402-4471` Skill 文件挂载
- `apps/agent/src/runtime/session-do.ts:4562` 无 key 注入证据
- `apps/agent/src/runtime/appendable-prompts.ts:23-31` 内置 appendable 提示
- `apps/console/src/pages/SkillsList.tsx:579` Console 二次绑定提示
- `apps/console/src/pages/agents/AgentFormDialog.tsx:1813-1822` 绑定 UI
- `apps/main-node/src/index.ts:587` 无 key 注入证据
- `apps/main-node/src/index.ts:601` Node system prompt 不解析 Skill
- `apps/main-node/src/index.ts:1031` Node /v1/skills stub
- `apps/main/src/routes/integrations.ts:75` installProxyFor（同类 service binding 模式）
- `packages/http-routes/src/sessions/index.ts:469/486` Session snapshot 固化
- `scripts/seed-aiops-digital-employees.ts:78-89` AIOps 假运维 skill（本 SDS 不解决）
- `scripts/seed-aiops-digital-employees.ts:139` tools: []（等价 defaultSet，本 SDS 不解决）
- `test/unit/tools-execution.test.ts:697` tools: [] 等价全开单测
- `docs/p0-version-snapshot-sds.md` §3.4 build/frozen 边界
- `docs/skill-onboarding/smoke-test-sop.md` 人工端到端验证