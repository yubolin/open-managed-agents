# Runtime 能力矩阵

> 状态：v0.1（2026-08-20）· 配套 `self-install-sds.md` §4.G + §6.6。
> 用途：明确每个工具 / API 在 Cloudflare Runtime 与 Node Runtime 上的支持状态，避免"CF 能用、Node 静默失败"。
> 不做什么：不解决 Node Runtime 的能力缺失本身——那是 Node 路线图范围。本文档只做**功能门控**的真相表。

---

## 0. Runtime 判定（先看这一节再查表）

| 信号 | 判定 |
|------|------|
| 部署用 `wrangler deploy`，KV/R2 binding 在 `wrangler.toml` | **Cloudflare** |
| 部署用 `node dist/main-node/index.js`，数据库是 Postgres / SQLite | **Node** |
| 部署用 `docker compose`，含 `apps/main-node` 服务 | **Node** |
| 不确定 | **停下来确认**——参考 `self-install-sds.md` 附录 A |

下文 CF 列基于 `apps/main/src/*`，Node 列基于 `apps/main-node/src/index.ts`。

---

## 1. 工具能力矩阵（agent 视角）

每个工具对应 SDS §4.A 的语义。

| 工具 | 默认权限 | CF | Node | Node 行为 | 证据 |
|------|---------|----|----|----------|------|
| `search_skill` | `always_allow`（只读）| ✅ | ⚠️ Stub | 返回 `200 + {data: []}`（**静默假阳性**——是 bug）| `main-node/index.ts:1033` |
| `install_skill` | `always_ask` | ✅ | ❌ | **必须**返回 `501 Not Implemented in this runtime` | `main-node/index.ts:1033` 无 `/skills` POST |
| `attach_skill` | `always_ask` | ✅（通过 `PUT /v1/agents/:id`）| ⚠️ 走 agents 路由 | agents 路由 Node 已实现，但 skill 解析未做 | `main-node/index.ts:911-930` + `:601` |
| `detach_skill` | `always_ask` | ✅ | ⚠️ 同上 | 同 attach_skill | 同上 |
| `uninstall_skill` | `always_ask` | ✅（`DELETE /v1/skills/:id`）| ❌ | **必须**返回 `501` | `main-node/index.ts:1033` |

### 1.1 行为契约（必须实现，禁止静默失败）

- **Node 上的 install / uninstall 必须返回 `501` + body `{ "error": "Not Implemented in this runtime", "runtime": "node" }`**
- **Node 上的 search_skill 必须返回 `501` 直到实现**（现状返回空数组会让 agent 误判为"没有 skill 可装"，**也是 bug**）
- **CF 上的所有工具按现有行为**

实现参考：把 `main-node/index.ts:1033` 的 stub 改成显式 501 handler：

```ts
v1.post("/skills", (c) =>
  c.json({ error: "Not Implemented in this runtime", runtime: "node" }, 501));
v1.get("/skills", (c) =>
  c.json({ error: "Not Implemented in this runtime", runtime: "node" }, 501));
v1.delete("/skills/:id", (c) =>
  c.json({ error: "Not Implemented in this runtime", runtime: "node" }, 501));
```

---

## 2. 核心 API 能力矩阵（运营 / Console 视角）

| API | CF | Node | Node 现状 | 证据 |
|------|----|----|---------|------|
| `POST /v1/agents` | ✅ | ✅ | 完整实现 | `main-node/index.ts:911` |
| `GET /v1/agents` | ✅ | ✅ | 完整实现 | 同上 |
| `PUT /v1/agents/:id` | ✅ | ✅ | 完整实现（含 optimistic concurrency 待 v0.2 加）| 同上 |
| `POST /v1/sessions` | ✅ | ✅ | 完整实现 | `main-node/index.ts:933` |
| `GET /v1/sessions` | ✅ | ✅ | 完整实现 | 同上 |
| `POST /v1/vaults` | ✅ | ✅ | 完整实现 | `main-node/index.ts:950` |
| `GET /v1/memory_stores` | ✅ | ✅ | 完整实现 | `main-node/index.ts:951` |
| `GET /v1/dreams` | ✅ | ✅ | 完整实现 | `main-node/index.ts:952` |
| `GET /v1/me` | ✅ | ✅ | 完整实现 | `main-node/index.ts:960` |
| `GET /v1/tenants` | ✅ | ✅ | 完整实现 | `main-node/index.ts:992` |
| `GET /v1/api_keys` | ✅ | ✅ | 完整实现 | `main-node/index.ts:993` |
| `GET /v1/evals` | ✅ | ✅ | 完整实现 | `main-node/index.ts:994` |
| `GET /v1/stats` | ✅ | ✅ | 完整实现 | `main-node/index.ts:1000` |
| `POST /v1/models/list` | ✅ | ✅ | 完整实现 | `main-node/index.ts:1050` |
| `GET /v1/environments` | ✅ | ✅ | 完整实现 | `main-node/index.ts:1034` |
| `GET /v1/model_cards` | ✅ | ✅ | 完整实现 | `main-node/index.ts:1038` |
| **`GET /v1/runtimes`** | ✅ | ❌ Stub | 返回 `200 + {data: []}`（**静默假阳性**）| `main-node/index.ts:1032` |
| **`GET /v1/skills`** | ✅ | ❌ Stub | 返回 `200 + {data: []}`（**静默假阳性**）| `main-node/index.ts:1033` |
| **`GET /v1/integrations/github/credentials`** | ✅ | ❌ Stub | 返回 `200 + {data: []}`（**静默假阳性**）| `main-node/index.ts:1090` |
| **`GET /v1/integrations/linear/credentials`** | ✅ | ❌ Stub | 返回 `200 + {data: []}`（**静默假阳性**）| `main-node/index.ts:1091` |
| **`GET /v1/integrations/slack/credentials`** | ✅ | ❌ Stub | 返回 `200 + {data: []}`（**静默假阳性**）| `main-node/index.ts:1092` |
| `GET /v1/files` | ✅ | ✅ | 完整实现 | `main-node/index.ts:1226` |
| `GET /v1/files/:id` | ✅ | ✅ | 完整实现 | `main-node/index.ts:1252` |
| `GET /v1/files/:id/content` | ✅ | ✅ | 完整实现 | `main-node/index.ts:1240` |
| `DELETE /v1/files/:id` | ✅ | ✅ | 完整实现 | `main-node/index.ts:1259` |
| `POST /v1/sessions/:id/memory_stores` | ✅ | ✅ | 完整实现 | `main-node/index.ts:1279` |
| `GET /v1/sessions/:id/memory_stores` | ✅ | ✅ | 完整实现 | `main-node/index.ts:1317` |

---

## 3. 已知"静默假阳性"汇总（必须修）

> **静默假阳性**：返回 200 但数据为空数组，让调用方误判"成功且无数据"，而不是"接口未实现"。
> 这是 SDS §5.3 的硬约束反例——**不修复不允许宣称功能门控**。

| API | 现状 | 必须改成 |
|-----|------|---------|
| `GET /v1/runtimes` | `200 + {data: []}` | `501 + {error, runtime:"node"}` |
| `GET /v1/skills` | `200 + {data: []}` | `501 + {error, runtime:"node"}` |
| `GET /v1/integrations/github/credentials` | `200 + {data: []}` | `501 + {error, runtime:"node"}` |
| `GET /v1/integrations/linear/credentials` | `200 + {data: []}` | `501 + {error, runtime:"node"}` |
| `GET /v1/integrations/slack/credentials` | `200 + {data: []}` | `501 + {error, runtime:"node"}` |

涉及代码：5 行，每行约 5 个字符变更 → 5-10 分钟工作量。**低风险高收益**。

---

## 4. Client SDK 行为契约（消费方）

无论 SDK 还是 Console，遇到以下状态必须显式提示用户：

| Runtime 返回 | Client 必须展示 |
|-------------|---------------|
| `200 + {data: []}` | "此 Runtime 不支持此接口"（**禁止**显示"无数据"）|
| `501 + {error: "Not Implemented in this runtime"}` | "当前 Runtime (node) 未实现此功能，请联系管理员" |
| `404` | "资源不存在"（区分 404 与 501）|

涉及 SDK：
- `packages/cli/src/index.ts`
- `packages/sdk/*`
- `apps/console/src/pages/*`

每处遇到 5 个静默假阳性 API 必须加分支判断。

---

## 5. 验收门（按 SDS §5.3）

```bash
# 5.3.1 Node 上调用每个 stub API
for path in /v1/runtimes /v1/skills /v1/integrations/github/credentials \
            /v1/integrations/linear/credentials /v1/integrations/slack/credentials; do
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "x-api-key: $OMA_API_KEY" \
    "$OMA_BASE_URL$path")
  if [ "$status" != "501" ]; then
    echo "FAIL: $path returned $status, expected 501"
  fi
done
# 期望：无 FAIL 输出

# 5.3.2 CF 上调用同样路径
# 期望：200 + 真实数据
```

---

## 6. 待办（开 v0.2 时跟进）

- [ ] 修 5 个静默假阳性 → 501（`main-node/index.ts:1032-1092`）
- [ ] Node SDK + Console Client 增加 501/200-empty 区分展示
- [ ] Node Runtime 实现 skill install/attach/uninstall（路线图，本文档仅门控）
- [ ] 文档自动化：CI 检查 `main-node/src/index.ts` 中不允许出现 `c.json({ data: [] })` 模式（除非附 TODO 注释）

---

## 附录 A：相关引用

- `apps/main-node/src/index.ts:1031-1033` Skills/Runtimes stub
- `apps/main-node/src/index.ts:1090-1092` Integrations credentials stub
- `apps/main-node/src/index.ts:601` Node system prompt 不解析 Skill
- `apps/main-node/src/index.ts:911-993` Node 已实现的路由（agents/sessions/vaults/memory_stores/dreams/me/tenants/api_keys/evals/stats/models/environments/model_cards）
- `apps/main/src/routes/clawhub.ts:40-98` CF ClawHub install
- `apps/main/src/routes/skills.ts:76-117` CF BUILTIN_SKILLS
- `apps/main/src/routes/skills.ts:325-385` CF parseSkillZipBytes（Node 应复用）
- `apps/agent/src/harness/skills.ts:46` CF resolveCustomSkills（Node 缺失）
- `apps/agent/src/runtime/session-do.ts:4402-4471` CF Skill 文件挂载（Node 缺失）
- `docs/skill-onboarding/self-install-sds.md` §4.A 工具权限、§4.G 门控、§5.3 验收门
- `docs/skill-onboarding/smoke-test-sop.md` §5-§7 链路验证