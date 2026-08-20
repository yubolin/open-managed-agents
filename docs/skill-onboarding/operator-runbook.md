# Operator Runbook — Skill 安装 Smoke Test

> 状态：v0.1（2026-08-20）· 配套 `smoke-test-sop.md`。
> 用途：给**现场操作员**按部就班的逐步 shell 命令、期望输出、截图位置、归档目录命名。
> 不做什么：本 runbook **不重复** SOP 的策略与门禁，只补 SOP 的"现场执行细节"。

---

## 0. 操作员必备

- 笔记本：macOS / Linux 都行（shell 一致）
- 终端：zsh 或 bash
- 截图工具：macOS `Cmd+Shift+4`，Linux `flameshot` / `gnome-screenshot`
- SSH 客户端：能连到 `117.72.219.106`（或其他目标服务器）
- VPN（如果目标服务器在内网）
- 操作员有目标 tenant 的 OMA_API_KEY（写权限）

---

## 1. 准备阶段

### 1.1 创建归档目录（每跑一次 smoke 新建）

```bash
TS=$(date +%Y%m%d-%H%M%S)
ROOT="$HOME/skill-smoke/$TS"
mkdir -p "$ROOT"/{screenshots,review}
echo "ROOT=$ROOT"
# 把 ROOT 写入 ~/.zshrc 临时环境变量，避免后续命令重复
echo "export ROOT=$ROOT" >> "$ROOT/env.sh"
```

记录到操作员笔记：`smoke-test-$TS started`

### 1.2 填入凭据

```bash
# 不要 echo，凭据直接进 shell history 有风险
unset OMA_BASE_URL OMA_API_KEY

# 用临时文件
cat > "$ROOT/creds.env" <<EOF
export OMA_BASE_URL="https://your-instance.example.com"
export OMA_API_KEY="oma_xxxxxxxxxxxxxxxx"
export OMA_RUNTIME_TYPE="cloudflare"  # 或 "node"，见 self-install-sds.md 附录 A
EOF
chmod 600 "$ROOT/creds.env"
source "$ROOT/creds.env"
```

**自检**：
```bash
[ -n "$OMA_BASE_URL" ] && [ -n "$OMA_API_KEY" ] && echo "OK" || echo "FAIL"
```

### 1.3 截图位置

后续每步会要求截图，统一归档到 `$ROOT/screenshots/`：

```
screenshots/
├── 01-before-baseline.png
├── 02-zip-review.png
├── 03-install-response.png
├── 04-agent-bind.png
├── 05-new-session.png
├── 06-new-session-system-prompt.png   # §6.2
├── 07-sandbox-mount.png                # §6.3
├── 08-tool-call-result.png             # §6.4
└── 09-old-session-unchanged.png        # §7
```

---

## 2. SOP §1 — 只读现状观测

### 2.1 读目标 Session

```bash
SESSION_ID="<你记录的 session id>"
oma api sessions get "$SESSION_ID" > "$ROOT/before-session.json"
```

**期望输出**：`before-session.json` 含 `agent_snapshot.skills: []`

**截图**：终端输出全屏 → `01-before-baseline.png`

### 2.2 读目标 Agent

```bash
AGENT_ID="<你记录的 agent id>"
oma api agents get "$AGENT_ID" > "$ROOT/before-agent.json"
```

**期望**：`before-agent.json` 含 `skills: []`

### 2.3 列出现有 skills

```bash
oma api skills list > "$ROOT/before-skills.json"
```

**期望**：`before-skills.json` 不含 `deployment-kit`

**异常**：
- 任意 step 返回非 200 → 立即停，联系 owner，不要继续
- 任一期望不符 → 立即停，先排查再继续

---

## 3. SOP §2 — 离线 zip 审查

### 3.1 下载 deployment-kit

> 来源：ClawHub verified tier 或 owner 自托管白名单 URL
> 不要从非白名单来源下载

```bash
mkdir -p "$ROOT/zip"
curl -fL -o "$ROOT/zip/deployment-kit.zip" "<whitelisted-url>"
ls -la "$ROOT/zip/deployment-kit.zip"
```

### 3.2 解压审查

```bash
unzip -l "$ROOT/zip/deployment-kit.zip" > "$ROOT/review/zip-listing.txt"
unzip "$ROOT/zip/deployment-kit.zip" -d "$ROOT/review/"
```

**自检清单**（必须全过）：
- [ ] 文件数 ≤ 500
- [ ] 解压后总大小 ≤ 100 MB
- [ ] 单文件 ≤ 25 MB
- [ ] 存在 `SKILL.md`
- [ ] 无 `../`、绝对路径、`\` 分隔符（`find . -name '..'` 应空）

**人工读**：
```bash
cat "$ROOT/review/SKILL.md" > "$ROOT/review/skill-md-summary.txt"
# 写 ≤200 字摘要到 $ROOT/review/skill-md-summary.txt
```

**截图**：终端 + 文件管理器 → `02-zip-review.png`

**不通过** → 停，**不安装**。

---

## 4. SOP §3 — CLI 安装

### 4.1 install

```bash
PINNED_VERSION="1.0.3"  # 显式版本，从 ClawHub verified tier 元数据拿
oma skills install deployment-kit --version "$PINNED_VERSION" \
  > "$ROOT/install-response.json"
```

**期望输出**：
- HTTP 201
- `install-response.json` 含 `id: "skill_xxx"` 和 `version: "$PINNED_VERSION"`

### 4.2 提取 ID

```bash
SKILL_ID=$(jq -r '.id' "$ROOT/install-response.json")
[ -n "$SKILL_ID" ] && [ "$SKILL_ID" != "null" ] || { echo "FAIL: no skill_id"; exit 1; }
echo "SKILL_ID=$SKILL_ID"
```

**截图**：终端输出 → `03-install-response.png`

**异常**：
- 502 / zip 下载失败 → 检查 ClawHub 可达性
- 404 / 包不存在 → 检查 slug 拼写
- 任意非 201 → **不要重试**，记录原始错误到 `$ROOT/error.log`

---

## 5. SOP §4 — Agent 绑定

### 5.1 更新 Agent 配置

```bash
oma api agents update "$AGENT_ID" --json "$(cat <<JSON
{
  "skills": [
    { "type": "custom", "skill_id": "$SKILL_ID", "version": "$PINNED_VERSION" }
  ]
}
JSON
)" > "$ROOT/agent-bind.json"
```

**期望**：HTTP 200 + `agent-bind.json` 含 `skills: [{type:"custom", skill_id, version}]`

**关键**：必须用 `$PINNED_VERSION`，**禁止** `"latest"`

**截图**：终端 → `04-agent-bind.png`

---

## 6. SOP §5 — 新建 Session

### 6.1 创建

```bash
ENV_ID="<你的 environment id>"
oma sessions create --agent "$AGENT_ID" --env "$ENV_ID" \
  --title "smoke-test-deployment-kit-$TS" \
  > "$ROOT/new-session.json"
```

### 6.2 提取新 Session ID

```bash
NEW_SESSION_ID=$(jq -r '.id' "$ROOT/new-session.json")
[ -n "$NEW_SESSION_ID" ] && [ "$NEW_SESSION_ID" != "null" ] || { echo "FAIL"; exit 1; }
echo "NEW_SESSION_ID=$NEW_SESSION_ID"
```

**截图**：终端 + JSON 输出 → `05-new-session.png`

---

## 7. SOP §6 — 端到端验证（4 项）

### 7.1 §6.1 新 Session snapshot 含 skill_id + version

```bash
oma api sessions get "$NEW_SESSION_ID" > "$ROOT/verify-snapshot.json"
jq '.agent_snapshot.skills' "$ROOT/verify-snapshot.json"
```

**期望**：
```json
[
  {
    "type": "custom",
    "skill_id": "skill_xxx",
    "version": "1.0.3"
  }
]
```

### 7.2 §6.2 SKILL.md 进入 system context

```bash
# 通过 Console → Sessions → 选 new session → 展开 system prompt
# 或者：
oma sessions messages get "$NEW_SESSION_ID" --first > "$ROOT/verify-first-msg.json"
grep -c 'deployment-kit' "$ROOT/verify-first-msg.json"
# 期望：≥ 1
```

**截图**：system prompt 完整截图（必须含 `<skill name="deployment-kit">` 段）→ `06-new-session-system-prompt.png`

### 7.3 §6.3 Skill 文件挂载到 sandbox

```bash
# 通过 runtime bridge（取决于部署）
oma runtimes exec "$NEW_SESSION_ID" 'ls -la /home/user/.skills/deployment-kit/' \
  > "$ROOT/verify-mount.txt"
```

**期望**：
```
SKILL.md
<其他文件>
```

**截图**：终端 + 文件列表 → `07-sandbox-mount.png`

### 7.4 §6.4 Agent 真实调用 Skill 内嵌的工具

通过 Console 发起一条消息让 agent 执行 deployment-kit 支持的操作（如 systemd 重启某 service）：

```bash
oma sessions message "$NEW_SESSION_ID" "请用 deployment-kit 检查 nginx 服务状态" \
  > "$ROOT/verify-tool-call.json"
```

观察：
- agent 用了 `bash` 工具
- bash 命令符合 deployment-kit SKILL.md 的指令模板
- 命令实际生效（用 `systemctl status nginx` 在 sandbox 内验证）

```bash
oma runtimes exec "$NEW_SESSION_ID" 'systemctl status nginx' \
  > "$ROOT/verify-systemctl.txt"
```

**截图**：agent 消息 + tool call + 验证输出 → `08-tool-call-result.png`

---

## 8. SOP §7 — 旧 Session 不变验证

```bash
# 重新读旧 Session snapshot
oma api sessions get "$CONTROL_SESSION_ID" > "$ROOT/control-after.json"
diff "$ROOT/before-session.json" "$ROOT/control-after.json"
```

**期望**：diff 空（无输出）

非空 → 漂移 → 失败。

**截图**：terminal diff 输出（必须空）→ `09-old-session-unchanged.png`

---

## 9. SOP §8 — 验收门 + Rollback

### 9.1 通过条件自检

操作员笔记打勾：
- [ ] §2 before JSON 已记录
- [ ] §3 zip 审查通过
- [ ] §4 install 成功，skill_id + version 记下
- [ ] §5 agent 绑定成功，明确 version
- [ ] §6 新 Session 创建成功
- [ ] §7.1-7.4 全过
- [ ] §8 旧 Session 无 diff
- [ ] 9 张截图归档

任一未打勾 → §9.2 rollback。

### 9.2 Rollback

```bash
# R1: 解除 Agent 的 skill 绑定
oma api agents update "$AGENT_ID" --json '{"skills": []}' \
  > "$ROOT/rollback-r1.json"

# R2: 删除已安装的 skill（仅当 §3 后没继续 §4 时）
oma api skills delete "$SKILL_ID" --version "$PINNED_VERSION" \
  > "$ROOT/rollback-r2.json"

# R3: 关闭并归档 smoke test 新 Session
oma sessions cancel "$NEW_SESSION_ID" > "$ROOT/rollback-r3.json"
```

写 `$ROOT/rollback.md`，每步记录执行结果。

---

## 10. 归档清单（操作员交付）

```bash
cd "$ROOT"
tar czf "skill-smoke-$TS.tar.gz" \
  before-*.json \
  install-response.json agent-bind.json new-session.json \
  verify-*.json verify-*.txt \
  control-after.json \
  rollback-*.json rollback.md \
  error.log 2>/dev/null || true

# 截图单独打包
tar czf "skill-smoke-$TS-screenshots.tar.gz" screenshots/

ls -la "skill-smoke-$TS.tar.gz" "skill-smoke-$TS-screenshots.tar.gz"
```

把两个 tarball + runbook 完成记录交给 owner / Architect。

---

## 11. 异常速查

| 症状 | 第一动作 |
|------|---------|
| 任何 step 返回 401 / 403 | 检查 `$OMA_API_KEY` 是否过期 / scope 是否含写 |
| 502 on install | 检查 ClawHub 可达性 + `verificationTier` |
| §7.1 不含 skill | 检查 §5 是否真绑定成功（看 `agent-bind.json`） |
| §7.2 grep 不到 deployment-kit | 检查 §4 的 `version` 拼写 |
| §7.3 mount 失败 | 检查 sandbox env + runtime 启动日志 |
| §7.4 tool call 不执行 | 检查 agent `tools` 字段是否含 `bash` |
| §8 diff 非空 | **立刻停**，联系 owner，**不要**尝试修复 |

---

## 附录 A：相关引用

- `smoke-test-sop.md` — 策略与门禁
- `self-install-sds.md` — SDS 设计意图
- `runtime-capabilities.md` §5.3 验收门 curl 脚本
- `sds-v0.2-review-checklist.md` §14 端到端 smoke 项