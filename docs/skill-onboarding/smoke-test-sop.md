# Skill 安装端到端 Smoke Test SOP

> 状态：v0.1（人工版，2026-08-20）· 不改 Core；操作员按部就班执行 8 步。
> 用途：把"marketplace 包进入租户 Skill 库 → 目标 Agent 能用 → 新 Session 生效 → 旧 Session 不漂移"这条**真实链路**打一遍。
> 不做什么：本 SOP **不**测试"对话内自安装"——那是 SDS（`self-install-sds.md`）阶段产物。
> 前置：本 SOP 之前必须先读 `self-install-sds.md` §0 评审史与 §1 缺口清单，确认粒度匹配。

---

## 0. 前置条件（不满足则**不开始**）

| # | 项 | 校验方式 | 失败动作 |
|---|----|---------|---------|
| P1 | Runtime 类型已确认 | 见 `self-install-sds.md` §A.1 | 停下来确认 |
| P2 | 操作员有目标 tenant 的 OMA_API_KEY（写权限） | `oma api keys list` | 停下来申请权限 |
| P3 | 目标 Agent ID（要绑定的）已记录 | `oma agents list` | 停下来确认 |
| P4 | 目标 Session ID（待 smoke test）已记录 | `oma sessions list --agent <id>` | 停下来确认 |
| P5 | 一个**对照 Session**（保持不变的旧 Session）已记录 | 同上 | 选一个已存在的旧 Session |
| P6 | `deployment-kit` zip 已离线下载并人工审查（见 §3） | `unzip -l deployment-kit.zip` + 人工读 SKILL.md + 审查 systemd unit 文件 | **不通过审查不安装** |
| P7 | 运维环境就绪：能 SSH 到目标服务器、能看到 agent 日志 | `oma runtimes list` 或直接访问 `wr tail` | 不就绪不开始 |

> **颗粒度对齐**：任一前置失败都立即中止，不要"先继续，回头再补"。

---

## 1. 只读现状观测（不改任何东西）

目的：拒绝把"Session URL 返回 HTTP 200"当成"Session 存在"的伪证据。

```bash
# 1.1 读目标 Session 的当前 agent snapshot（必须用 API，不是浏览器）
oma api sessions get <SESSION_ID>
# 1.2 读目标 Agent 当前配置 + skills 绑定
oma api agents get <AGENT_ID>
# 1.3 列出 tenant 现有 skills（验证是否已有 deployment-kit）
oma api skills list
```

记录到本地：`smoke-<timestamp>-before.json`，**含完整响应**，不是 SPA HTML。

期望：
- §1.1 的 `agent_snapshot` 不含任何 `skill_*`（当前 baseline）
- §1.2 的 `skills` 字段为空数组 `[]`
- §1.3 不返回 `deployment-kit`

**异常**：任何一项不是期望，停下来排查，**不要继续**。

---

## 2. 离线 zip 审查（必须做，零网络操作）

```bash
unzip -l deployment-kit.zip
# 检查项：
#   - 文件数量（参考 skills.ts:321 上限 500，留 20× 余量）
#   - 解压后总大小（参考 skills.ts:319 上限 100 MB）
#   - 单文件最大（参考 skills.ts:320 上限 25 MB）
#   - 必须存在 SKILL.md（参考 skills.ts 的结构校验）

mkdir /tmp/deployment-kit-review
unzip deployment-kit.zip -d /tmp/deployment-kit-review/

# 人工读：
#   - SKILL.md（看系统提示里会给 agent 什么）
#   - 任何 *.service / nginx.conf / scripts/*.sh
#   - 任何 README / INSTALL
```

记录到本地：`smoke-<timestamp>-review.md`，含：
- 文件清单（含 size）
- SKILL.md 关键摘要（≤200 字）
- systemd / nginx / 告警脚本风险点
- 对目标环境的适配性判断（通过/不通过）

**审查不通过** → 停。不通过审查的 zip 不能进入租户。

---

## 3. CLI 安装（写操作 — 但只是包入库，不绑 Agent）

```bash
# 显式指定版本，不漂移到 "latest"
oma skills install deployment-kit --version <PINNED_VERSION>
# 记下返回的 skill_id 和 version（重要，下一步要用）
```

记录：`smoke-<timestamp>-install.json`，含：
- `skill_id`（形如 `skill_xxxxxxxxxxxx`）
- `version`（具体数值，不是 "latest"）
- HTTP 状态码 + 完整响应

**异常处理**：
- 502（zip 下载失败）→ 检查 ClawHub 可达性，可能需要切镜像
- 404（package 不存在）→ 检查 slug 拼写
- 任意非 201 → 停下来，**不要重试**，记录原始错误

---

## 4. Agent 绑定（写操作 — 二次绑定，不可跳过）

```bash
# 把 skill 以**明确版本**绑进 Agent 的 skills 字段
oma api agents update <AGENT_ID> \
  --json '{
    "skills": [
      { "type": "custom", "skill_id": "<SKILL_ID>", "version": "<PINNED_VERSION>" }
    ]
  }'
```

记录：`smoke-<timestamp>-agent-bind.json`，含：
- 更新前的 agent snapshot
- 更新后的 agent snapshot
- HTTP 状态码

**关键**：必须用 `version: "<PINNED_VERSION>"`，**禁止** `"latest"`。漂移到 latest 会让 Session 行为不可重现。

---

## 5. **新建 Session**（不是给既有 Session 续命）

> **为什么是新建**：既有 Session 的 `agent_snapshot` 已在 `sessions/index.ts:469/486` 固化、`session-do.ts:400` Runtime 优先读快照。新装 skill 不会回灌到既有 Session。

```bash
oma sessions create --agent <AGENT_ID> --env <ENV_ID> \
  --title "smoke-test-deployment-kit-<timestamp>"
# 记下返回的 session_id
```

记录：`smoke-<timestamp>-new-session.json`，含完整响应。

---

## 6. 端到端验证（4 项必须全过）

### 6.1 Session snapshot 含 skill_id + version

```bash
oma api sessions get <NEW_SESSION_ID>
# 期望：agent_snapshot.skills 含 [{type:"custom", skill_id:"<SKILL_ID>", version:"<PINNED_VERSION>"}]
```

### 6.2 SKILL.md 进入 system context

```bash
oma sessions messages get <NEW_SESSION_ID> --first
# 或者通过 Console → Sessions → 选 session → 展开 system prompt
# 期望：system prompt 中包含 <skill name="deployment-kit"> 段
```

### 6.3 Skill 文件挂载到 sandbox

```bash
# 通过 runtime bridge 或 SSH 到 sandbox（取决于部署）
ls -la /home/user/.skills/deployment-kit/
# 期望：含 SKILL.md + 所有声明的文件
```

### 6.4 Agent 真实调用 Skill 内嵌的工具

让 agent 执行一个 deployment-kit SKILL.md 中明确支持的操作（例如 systemd 重启某个 service），观察：
- agent 用了 `bash` 工具
- bash 命令符合 deployment-kit SKILL.md 的指令模板
- 命令实际生效（用 `systemctl status <svc>` 验证）

**任一项不通过** → 失败。回到 §3 检查 zip 完整性，回到 §4 检查 version 拼写。

---

## 7. 旧 Session 不变验证（防漂移）

```bash
# 重新读对照旧 Session 的 snapshot
oma api sessions get <CONTROL_SESSION_ID>
# 期望：与 §1.1 记录的"before"完全一致
diff smoke-<timestamp>-before.json smoke-<timestamp>-control-after.json
```

**期望 diff 为空**。任何字段变动 = 漂移 = **失败**。

---

## 8. 验收门 + Rollback 清单

### 8.1 通过条件（**全部满足**）

- §1 baseline 已记录
- §2 zip 审查通过
- §3 install 成功，skill_id + version 记下
- §4 agent 绑定成功，明确 version
- §5 新 Session 创建成功
- §6 6.1-6.4 全过
- §7 旧 Session 无 diff

### 8.2 Rollback 清单（**任一验证失败**触发）

```bash
# R1: 解除 Agent 的 skill 绑定
oma api agents update <AGENT_ID> --json '{"skills": []}'

# R2: 删除已安装的 skill（仅当 §3 后没继续 §4 时）
oma api skills delete <SKILL_ID> --version <PINNED_VERSION>

# R3: 关闭并归档 smoke test 新 Session
oma sessions cancel <NEW_SESSION_ID>
```

记录：`smoke-<timestamp>-rollback.md`，含每步执行结果。

### 8.3 产出物清单（全部归档）

- `smoke-<timestamp>-before.json`（baseline）
- `smoke-<timestamp>-review.md`（zip 审查）
- `smoke-<timestamp>-install.json`（install 响应）
- `smoke-<timestamp>-agent-bind.json`（agent 更新）
- `smoke-<timestamp>-new-session.json`（新 session）
- `smoke-<timestamp>-control-after.json`（旧 session 复核）
- 截图：§6.2 system prompt 含 skill 段
- 截图：§6.3 sandbox 挂载目录

---

## 9. 已知不能做的事（防越界）

- ❌ 不要试"对话内让 agent 自己 install"——本 SOP 不覆盖
- ❌ 不要省略 §2 zip 审查
- ❌ 不要用 `version: "latest"`——明示不可重现
- ❌ 不要在 §4 之前尝试"装完就能用"——已被 Session snapshot 冻结机制证伪
- ❌ 不要把 SPA URL 200 当作现网证据
- ❌ 不要在没有 rollback 路径的情况下继续

---

## 附录 A：相关引用

- `self-install-sds.md` §0 评审史，§1 缺口清单，§A.1 Runtime 判定
- `apps/main/src/routes/skills.ts:319-321` ZIP bomb 防护（参考上限）
- `apps/main/src/routes/clawhub.ts:40-98` install 端点
- `apps/console/src/pages/SkillsList.tsx:579` Console 二次绑定提示
- `packages/http-routes/src/sessions/index.ts:469/486` Session snapshot 固化
- `apps/agent/src/runtime/session-do.ts:400` Runtime 优先读快照
- `test/unit/tools-execution.test.ts:697` `tools: []` 等价全开（防误解）