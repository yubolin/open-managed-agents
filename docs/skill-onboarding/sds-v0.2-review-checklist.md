# SDS v0.2 重审 Checklist

> 状态：v0.2 重审工具（2026-08-20）· 配套 `self-install-sds.md` v0.1。
> 用途：把 SDS v0.1 的 12 项要求**逐项可验证化**——通过条件、证据要求、测试要求、责任人。任何一项 ❌ 即 v0.2 仍 No-go。
> 颗粒度：本 checklist 全部项必须可机器验证或人工 grep 验证，**不接受**"已经做了" / "差不多" / "应该可以"。

---

## 0. 评审门（v0.1 → v0.2 切换条件）

| 维度 | 通过条件 |
|------|---------|
| 12 项要求 | 全部 §1 - §12 通过 |
| 单测覆盖 | 新增 ≥ 30 个测试用例，覆盖 happy / unhappy / edge / concurrent |
| 集成测 | `test/integration/skill-lifecycle.test.ts` 全过（5 类场景）|
| E2E | `docs/skill-onboarding/smoke-test-sop.md` 8 步全部执行通过 |
| 文档 | 本 checklist + SDS v0.2 + runtime-capabilities v0.2 全部 reviewed |
| 供应链 | ZIP bomb / 路径穿越 / 重复安装 三类攻击 payload 全部被拦截 |
| 凭据隔离 | sandbox env 中无 OMA_* 变量（grep 验证）|
| 审计 | 至少 4 类事件（install/attach/detach/uninstall）落到审计表 |
| 兼容性 | CF + Node 两 Runtime 行为符合 `runtime-capabilities.md` |

**任一未达 → v0.2 仍 No-go，不允许发版**。

---

## 1. 三档工具默认权限

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 1.1 search_skill | `always_allow`（只读）| `harness/tools.ts` 注册 + `harness/registry.ts` 权限表 | 单测 `search_skill.test.ts` 含 tenant scope 测试 | Backend |
| 1.2 install_skill | `always_ask` + 需 `confirmation_token` | `harness/tools.ts` + 新增 `tools/install-skill.ts` | 单测 + 集成测拒绝无 token 调用 | Backend |
| 1.3 attach_skill | `always_ask` + 需 `confirmation_token` + 强制 `version` 非空 | 同上 | 同上 | Backend |
| 1.4 detach_skill | `always_ask` + 需 `confirmation_token` | 同上 | 同上 | Backend |
| 1.5 uninstall_skill | `always_ask` + 需 `confirmation_token` | 同上 | 同上 | Backend |
| 1.6 默认禁 `latest` | API 接受 `version: "latest"` → 400 | `routes/clawhub.ts` + `routes/skills.ts` | 单测：传 "latest" 返回 400 | Backend |

---

## 2. 平台内部身份传递（控制面隔离）

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 2.1 sandbox env 无 OMA_API_KEY | `grep -r OMA_API_KEY apps/agent/src/runtime/ ` 无 hits | git diff + CI grep 检查 | 集成测：runtime boot 后 `env \| grep OMA` 空 | Backend |
| 2.2 sandbox 工具入参无密钥 | 工具 schema 定义中无 `api_key` / `token` 字段 | git diff | 单测：检查 5 个工具 schema | Backend |
| 2.3 install_skill 走 service binding | 实现文件中 `fetch(${OMA_BASE_URL}/...)` 字面无 hits，改用 `ctx.env.SKILL_RPC.fetch(...)` | git diff | 集成测：mock service binding 验证调用路径 | Backend |
| 2.4 attach_skill 走 service binding | 同 2.3 | git diff | 同 2.3 | Backend |

---

## 3. 包来源白名单 + 版本锁定 + 哈希

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 3.1 ClawHub verified tier 白名单 | `clawhub.ts` 增加 `verificationTier` 检查 | `clawhub.ts:40-98` 改 | 单测：传未 verified 包 → 403 | Backend |
| 3.2 自托管白名单 URL | 新增 `OMA_SKILL_WHITELIST_URLS` 配置 | `wrangler.toml` + `.env.example` | 单测：不在白名单的 URL → 403 | Backend |
| 3.3 拒绝 `version: "latest"` | 见 §1.6 | — | — | — |
| 3.4 install 后写 sha256 | `skill_versions.hash` 字段持久化 | migration `0xxx_skill_hash.sql` | 单测：sha256 写入 | Backend |
| 3.5 attach 时校验 hash | attach 路径上比对 hash | `routes/agents.ts` PUT handler | 单测：hash 不匹配 → 409 | Backend |

---

## 4. ZIP bomb / 路径穿越 / 重复安装

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 4.1 抽出 `parseSkillZipBytes` 到 `lib/skill-zip.ts` | `clawhub.ts` 调用统一函数 | `git mv skills.ts:325-385 → lib/skill-zip.ts` | 单测复用 | Backend |
| 4.2 总解压上限 100 MB | 复用 `ZIP_MAX_TOTAL_UNCOMPRESSED` | `lib/skill-zip.ts:319` | 集成测：1KB / 10GB 攻击 zip | Backend |
| 4.3 单文件上限 25 MB | 复用 | `lib/skill-zip.ts:320` | 同上 | Backend |
| 4.4 文件数上限 500 | 复用 | `lib/skill-zip.ts:321` | 同上 | Backend |
| 4.5 路径穿越 | 拒绝 `../`、绝对路径、`\` 分隔符 | `lib/skill-zip.ts` 新增校验 | 集成测：恶意 zip 路径测试 | Backend |
| 4.6 必须存在 `SKILL.md` | 缺失 → 400 | 同上 | 单测 | Backend |
| 4.7 重复安装幂等 | 同 `(tenant, skill_id, version)` 第二次返回 200，不重写 R2 | `routes/clawhub.ts:41` 改 | 单测 + 集成测：并发 100 次 install | Backend |

---

## 5. tenant isolation + 审计 + 配额

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 5.1 强制 tenant scope | 所有 skill 操作 KV key 前缀 `t:{tenant_id}:` | grep 验证 + 单测 | 集成测：跨 tenant 调用 → 403 | Backend |
| 5.2 审计事件 install | 审计表新增行 | `routes/audit.ts` 新增 `skill.install` 处理器 | 集成测 | Backend |
| 5.3 审计事件 attach | 同上 | 同上 | 同上 | Backend |
| 5.4 审计事件 detach | 同上 | 同上 | 同上 | Backend |
| 5.5 审计事件 uninstall | 同上 | 同上 | 同上 | Backend |
| 5.6 配额：skills ≤ 200 | 超限 → 429 | `routes/skills.ts` | 单测 | Backend |
| 5.7 配额：累计存储 ≤ 500 MB | 同上 | 同上 | 单测 | Backend |
| 5.8 配额：install 频次 ≤ 100/h | 同上 | 同上 | 单测 | Backend |

---

## 6. 卸载与回滚

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 6.1 detach 必须先于 uninstall | uninstall API 检查 Agent 引用计数 | `routes/skills.ts` DELETE handler | 集成测 | Backend |
| 6.2 uninstall 校验无引用 | 同上 | 同上 | 集成测 | Backend |
| 6.3 tombstone 30 天保留 | skill 标记 `tombstoned_at`，前端不展示但保留 | `skill_versions.tombstoned_at` 字段 | 单测 | Backend |
| 6.4 attach 失败回滚 | 见 §10 | — | — | — |

---

## 7. CF / Node 一致能力或功能门控

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 7.1 Node install_skill 返回 501 | `main-node/index.ts:1033` 改 | git diff | 验收门 §5.3.1 curl 验证 | Backend |
| 7.2 Node uninstall_skill 返回 501 | 同上 | git diff | 同上 | Backend |
| 7.3 Node search_skill 返回 501 | 同上（**关键：现状是 200+空数组的静默假阳性**）| git diff | 同上 | Backend |
| 7.4 Node 其他 stub 一并修 | `runtimes` + `integrations/{github,linear,slack}/credentials` 5 个 API | `main-node/index.ts:1032-1092` 改 | 验收门 | Backend |
| 7.5 SDK Client 区分 501/200-empty/404 | `packages/sdk/*` + `packages/cli/*` + `apps/console/src/pages/*` | git diff | 单测 | Frontend + SDK |

---

## 8. Session 不漂移（build vs frozen）

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 8.1 attach 返回 `new_session_required: true` | attach_skill 工具返回体增加字段 | git diff | 集成测 | Backend |
| 8.2 frozen Session 不回灌 | attach 后既有 Session snapshot 不变 | 参考 `p0-version-snapshot-sds.md` §3.4 | E2E：smoke SOP §7 | Backend |
| 8.3 build/frozen 边界 | Runtime 初始化前可改，之后不可改 | 复用现有 snapshot 机制 | E2E | Backend |

---

## 9. Agent 更新 optimistic concurrency

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 9.1 `PUT /v1/agents/:id` 接受 `If-Match: <etag>` | `routes/agents.ts` | git diff | 单测 | Backend |
| 9.2 冲突返回 409 | 同上 | 同上 | 单测 | Backend |
| 9.3 body 含最新 etag | 同上 | 同上 | 单测 | Backend |
| 9.4 attach_skill 自动 retry-once | 工具实现 | git diff | 集成测 | Backend |

---

## 10. 失败不留半完成状态

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 10.1 install_skill 支持 `commit=true\|false` | 工具 schema | git diff | 单测 | Backend |
| 10.2 attach_skill 支持 `commit=true\|false` | 同上 | git diff | 单测 | Backend |
| 10.3 dry-run → commit 二阶段 | 实现 + 文档化 | git diff | 集成测：故意让 commit 失败，verify 无 R2/KV 副作用 | Backend |
| 10.4 失败回滚到上一个 version | 实现 | git diff | 集成测 | Backend |

---

## 11. 默认 `always_ask`

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 11.1 写工具默认 `always_ask` | `harness/registry.ts` 权限表 | git diff | 单测 | Backend |
| 11.2 admin_allowlist 配置 | 新增 `OMA_SKILL_ADMIN_ALLOWLIST` | `.env.example` + `wrangler.toml` | 单测 | Backend |
| 11.3 白名单变更审计 | 白名单变更事件落审计 | `routes/audit.ts` | 集成测 | Backend |

---

## 12. 不暴露平台 token

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 12.1 sandbox env 无 OMA_* | 见 §2.1 | — | — | — |
| 12.2 工具入参无 token | 见 §2.2 | — | — | — |
| 12.3 工具结果字符串无 token | LLM 可见的 response 中无 secret | git diff | 单测 | Backend |
| 12.4 部署验证 | `oma runtimes exec <id> 'env \| grep -i oma'` 为空 | `runtime-capabilities.md` §5.1 curl 脚本 | E2E | Ops |

---

## 13. 跨 Runtime 一致性矩阵更新

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 13.1 `runtime-capabilities.md` v0.2 | 反映 v0.2 后的真实能力 | git diff | review | Backend |
| 13.2 静默假阳性清零 | §7.1-7.4 完成后 | 见 §7 | 验收门 §5.3 | Backend |

---

## 14. 端到端 smoke test

| 项 | 通过条件 | 证据要求 | 测试要求 | 责任人 |
|----|---------|---------|---------|--------|
| 14.1 SOP 8 步全过 | 见 `smoke-test-sop.md` §8.1 | 8 份 JSON + 截图归档 | E2E | Ops |
| 14.2 旧 Session 无 diff | `diff before.json after.json` 空 | 同上 §7 | E2E | Ops |
| 14.3 Rollback 路径已演练 | R1/R2/R3 至少演练一次 | `smoke-<ts>-rollback.md` | E2E | Ops |

---

## 15. 文档完整性

| 项 | 通过条件 | 证据要求 | 责任人 |
|----|---------|---------|--------|
| 15.1 SDS v0.2 已发布 | `self-install-sds.md` 头部更新到 v0.2 + 状态从 No-go → Green | git diff | Architect |
| 15.2 SOP 已验证 | `smoke-test-sop.md` §8 全部产物归档 | E2E | Ops |
| 15.3 runtime-capabilities v0.2 | §13.1 完成 | git diff | Backend |
| 15.4 CHANGELOG | `CHANGELOG.md` 新增 v0.2 条目 | git diff | Release |

---

## 评审流程

1. Backend 按本 checklist 逐项实现 + 自测
2. Backend 在 PR 描述里贴出本 checklist，每项打 ✅/❌
3. Architect 评审所有文件:line 证据
4. Ops 执行 smoke SOP 全 8 步
5. 全过 → v0.2 → Green；任一 ❌ → v0.2 仍 No-go

---

## 附录 A：相关引用

- `self-install-sds.md` v0.1 + 附录 B（12 项 ↔ 章节）
- `runtime-capabilities.md` v0.1 §3（静默假阳性）
- `smoke-test-sop.md` 8 步 + §8.2 Rollback
- `p0-version-snapshot-sds.md` §3.4 build/frozen 边界
- `test/unit/tools-execution.test.ts:697`（防误解 `tools: []`）