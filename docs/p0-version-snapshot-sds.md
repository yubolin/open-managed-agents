# P0 底座 B · 版本快照 SDS

> 状态：v0.7（2026-08-17）· **GREEN（代码与自动化合同）**；真实目标环境迁移演练与双 Runtime 外部模型 E2E 仍按验收门单列，不以自动化测试替代。本版完成 v0.6 的 `legacy_unversioned`、CAS、指定版本解析与 Thread 事实源合同。
> 评审史：v0.1 No-go（现状前提错误）；v0.2 No-go（"创建后不可变"打断合法构建期链路）；v0.3 No-go（缺 CAS 竞争规则；CF 委派是子 Thread 而非子 Session，无快照事实源）；v0.4 设计评审通过。
> 上游：aiops-platform-reuse-and-roadmap.md（v4.2）§3 P0 底座 B；operations-workspace-prd.md §7 K1。
> 证据说明：§3 file:line 来自复审引用（2026-08-17 第四至七轮）。

## 1. 真实缺口（对齐现状）

平台已有 Session 创建时固化 `agentSnapshot` 的机制。缺口是三个：

| # | 缺口 | 现状证据 |
|---|------|----------|
| G1 | 显式 `{id, version}` 中的 `version` 被忽略 | sessions/index.ts:296 接收但不使用，:341 创建时读取当前 Agent |
| G2 | 子 Agent 委派只按 ID 重新取当前配置，不使用父快照中 `callable_agents` 的目标版本；CF 委派创建的是**同 SessionDO 内的子 Thread**，Thread 仅持久化 `agent_id/agent_name/parent_thread_id/时间字段`，**无处保存子 Agent 完整快照**——事后既无法证明、也无法回放"调的是哪个版本" | tools.ts:1193；session-do.ts:3961、:5136 |
| G3 | 快照**构建期与冻结期没有显式边界，且更新与冻结之间没有原子竞争规则**：`agent_snapshot` 可随时更新；"创建后、Runtime 初始化前"的更新是合法集成流程（§3.4），但冻结之后不应再可变 | sessions-store/service.ts:159；internal.ts:273、:361 |

**不是**"Session 尚无 resolved snapshot"，**不是**"需要新增快照列"，**也不是**"数据库行创建后立即不可变"。

## 2. 非目标

- 不设计 Run `resolved_snapshot`（模板版本、申请参数、工作流、知识源、审批策略、计划与证据）——**与 Session agent 快照是不同聚合**，Run 数据模型 spec 在 PRD 定稿后编写；
- 不在 Session 快照中放 `knowledge_refs`/`policy_refs` 占位字段——避免用错误的聚合边界锁死将来的 Run spec；
- 不做知识源/策略/模板的内容管理。

## 3. 现况（正确版）

### 3.1 Session 创建链路（已有快照）

`POST /v1/sessions`：接收 `agent: {id, version?}`（version 未使用，:296）→ 创建时读取当前 Agent（:341）→ 生成并保存完整 `agentSnapshot`（:363）→ 写入 Session（:443）。Runtime 优先读取该快照（apps/agent/src/runtime/session-do.ts:399）。

### 3.2 版本存储模型

`agent_versions` **只保存历史版本，当前版本保存在 `agents` 主表**（agents-store/service.ts:99、types.ts:9）。解析算法不能只调 `getVersion(version)`，见 §4.1。

### 3.3 委派能力（CF 已支持递归）

CF Runtime 已支持递归委派与**父子线程树**（session-do.ts:3872、:4030）——委派不创建子 Session，而是在**同一 SessionDO 内创建子 Thread**。版本传播必须覆盖整棵委派树，见 §4.3/§4.5。

### 3.4 构建期更新链路（G3 的关键事实）

集成发布链路（apps/main/src/routes/internal.ts:273、:361）存在**合法**流程：

1. 创建 Session（生成 `sessionId`，快照初版落库）；
2. 用 `sessionId` 构造 Linear MCP URL；
3. **更新 `agentSnapshot`**（写入带会话凭据的 MCP 配置）；
4. 最后初始化 Runtime。

结论：快照更新路径**不能封死**。缺的不是"不可变"，而是**构建态与冻结态之间的显式边界 + 原子竞争规则**。

### 3.5 CF Thread 持久化字段（G2 的关键事实）

Thread 当前仅持久化：`agent_id`、`agent_name`、`parent_thread_id`、时间字段（session-do.ts:3961、:5136）。**没有任何快照内容**——因此"事件记指针"的前提必须先补一个可指向的完整快照事实源（§4.5）。

## 4. 设计

### 4.1 版本解析算法（tenant scope 全程保持）

1. 租户范围内读取当前 Agent；
2. 请求 version == 当前版本 → 使用 `agents` 行；
3. 请求 version < 当前版本 → 读取 `agent_versions`；
4. 请求 version > 当前版本或不存在 → 明确 404（版本不存在）；
5. 全过程 tenant scope；跨租户探测版本一律拒绝。

### 4.2 显式版本生效（G1）

| 请求 | 行为 |
|------|------|
| `{id, version}` | 按 §4.1 解析，`agentSnapshot` 从该版本生成 |
| `{id}`（现状兼容） | 维持现状：从当前版本生成快照 |

快照生成与持久化复用现有机制（:363/:443），本项只是让 version 参数生效。

### 4.3 委派树版本传播（G2 前半）

- 版本传播覆盖**整个委派树**（递归）；
- 每次委派从**当前调用 Agent 的已解析 callable roster**（其快照中的 `callable_agents`）解析目标 `{agent_id, agent_version}`，子线程快照按该版本生成并**即刻冻结**（子快照无构建期）；
- 保留深度、并发数、循环检测等治理限制；
- **Node 与 CF 分别验收，不能用其中一个代表另一个**；
- 公开 API 的版本语义必须先统一定义；实现可分阶段。

**绑定补充 1（go-ahead 决议）**：版本固定应用于"**每个 Runtime 允许发生的委派层级**"，不强行统一委派深度——**Node Phase 0 可保持单层，CF 可递归**。

### 4.4 快照生命周期：`building → finalized` + CAS（G3）

**存储字段（不复用 `SessionStatus`——它表达 idle/running 等运行态，是另一个维度）**：

| 字段 | 说明 |
|------|------|
| `snapshot_state` | `building` \| `finalized` \| `legacy_unversioned`（存量 `agent_snapshot=null` 的显式分类，仅迁移语义，见下） |
| `snapshot_hash` | 当前快照内容哈希（算法见 §4.5） |
| `snapshot_finalized_at` | 冻结时间 |

**CAS 原子规则（堵住"Updater 读 A → Finalizer 冻 A → Updater 写 B"竞争）**：

| 操作 | 语义 |
|------|------|
| `updateSnapshot(expected_hash, new_snapshot)` | 仅当 `snapshot_state=building AND snapshot_hash=expected_hash` 才成功；成功后整体替换快照并更新 `snapshot_hash` |
| `finalize(expected_hash)` | 原子校验当前哈希与 `expected_hash` 一致并转为 `finalized`，写 `snapshot_finalized_at` |
| finalized 后任何 update | **409**（`already_finalized`） |
| CAS 条件不满足（哈希不一致/状态竞争） | **409**（`hash_mismatch`），不允许盲写覆盖 |

- **绑定补充 2（go-ahead 决议）**：CAS 必须在 **adapter 层**落实为带 `snapshot_state + expected_hash` 条件的**单条 UPDATE**，按 **affected-rows** 判断成功；**禁止 service 层先读后写**；
- **Runtime init 从存储重新读取并校验 `finalized`**，不信任调用方传入的状态；building 态拒绝 init；
- 生命周期仅针对**主 Session 快照**（存在构建期）；**子 Agent 快照在委派时一次性生成即冻结**（§4.3），无 building 态；
- 重复 finalize 幂等：同哈希 no-op 成功，异哈希 409；
- 构建崩溃：停留 building，无半冻结态，可幂等重建或废弃；
- **存量迁移（绑定补充 3，分阶段）**：①先加 nullable 字段；②由应用层按 JCS 回填**非空**历史快照（回填后标 `finalized` 并写 `snapshot_hash`）；③再启用新写入约束。`agent_snapshot=null` 的 legacy Session **必须显式分类**——RED 批次（第八轮）定名为 **`legacy_unversioned`**：两态 `building|finalized` 无法表达"无版本化快照的存量行"，强塞 building 即误标。`legacy_unversioned` 仅为迁移显式化分类：**不可作为 CAS 更新起点**（无基线哈希可校验），不参与 building/finalized 语义；需要版本化快照时创建新 Session 或显式重建。

**热更新禁止（裁决内嵌）**：finalized 后**不存在**合法热更新场景。运行中的动态变化分别进入：Session resources、用户/系统事件、凭据刷新通道、工作流上下文、新建 Session 或显式新 Run revision。未来确需改变工具、prompt、MCP 或 Agent 版本时，创建新 Session 或显式新 revision，**禁止原地改写审计基线**。

### 4.5 子 Agent 快照事实源 + 轻量委派事件（G2 后半）

原则：**事件轻、事实源完整**。

**事实源（选型已裁决，2026-08-17 第七轮）：扩展 Runtime 自己的 Thread 记录，不建中央独立 `session_agent_snapshots` 表。**

存储所有权理由：

- CF Thread 权威数据在 SessionDO SQLite，与事件处于**同一原子域**（session-do.ts:5125）；
- Node 已有 `session_threads` 表（packages/db-schema/src/node-sqlite/feishu-ops.ts:56）；
- 放中央独立表会让 CF 委派产生 DO SQLite + MAIN_DB **跨存储双写**，反而削弱一致性。

两个 Runtime 的 Thread 记录统一增加逻辑字段：

| 字段 | 说明 |
|------|------|
| `agent_version` | 委派解析出的目标版本 |
| `agent_snapshot` | 完整、冻结的子 Agent snapshot（JSON） |
| `config_hash` | §4.5 哈希规范计算的内容哈希 |
| `hash_algorithm` | 哈希算法标识（当前 `sha256:jcs-rfc8785:v1`） |

- 完整快照**不出现在 Thread 列表 API**；列表查询继续显式选择轻量字段；
- 委派事件只保留五元组 `thread_id / parent_thread_id / agent_id / agent_version / config_hash`，指向 Thread；
- `agents` / `agent_versions` 只是配置管理历史，**不作为既有 Session 审计与回放的依赖**——Agent 删除、归档策略和历史留存不得影响既有 Session 的审计与回放（快照事实源自包含）。

**`config_hash` 规范（选型已裁决：RFC 8785/JCS；仓库无现成稳定实现，不手写排序器）**：

```text
hash_algorithm = sha256:jcs-rfc8785:v1
config_hash    = hex(sha256(JCS(json_snapshot)))
```

- 计算前先将快照**严格转换为可持久化 JSON 值**：对象中的 `undefined` 按 JSON 语义移除；拒绝 `NaN`、`Infinity`、`BigInt` 等非 JSON 值；数组顺序保留；**哈希对象必须与实际落库对象完全一致**；
- 使用**经过验证的 JCS 库**，封装为 Node/CF 共用函数，并用**固定 golden vectors** 验证跨 Runtime 一致性。

## 5. API 兼容性

| 调用方 | 影响 |
|--------|------|
| 只传 `{id}` | 无感（快照机制不变） |
| 传 `{id, version}` | 从"被忽略"变为"生效"，属修复 |
| 构建期更新快照的集成链路（internal.ts） | **保持可用**，收紧为 CAS 更新（仅 building 态） |
| finalized 后更新 / CAS 哈希不匹配 | 行为变更：409（`already_finalized` / `hash_mismatch`） |

## 6. TDD 计划（已获 go-ahead，RED 先行）

1. 显式 version 生效：创建后快照 = 指定版本（RED：当前被忽略）；
2. 版本解析算法：==current / <current（历史表）/ >current·不存在（404）三分支 + 跨租户版本探测负向测试；
3. 委派版本传播：子线程快照 = 调用方 roster 固定版本（RED：当前按 ID 取 current）；含递归树与治理限制（深度/并发/循环）；
4. **生命周期 CAS**：building 态 CAS 更新成功（§3.4 链路回归）；重复 finalize 同哈希 no-op、异哈希 409；finalized 后更新 409；**三组竞争测试必进**：`update‖finalize`、`update‖update`、`finalize‖init`；adapter 单条条件 UPDATE + affected-rows 判定（禁止先读后写）；Runtime init 从存储重读并校验 finalized（不信调用方状态）；构建崩溃停留 building、可幂等重建；
5. **事实源与审计（绑定补充 4）**：同时覆盖 CF `threads` 与 Node `session_threads`，证明**删除 Agent 及历史版本后，完整子快照仍可回放**；委派事件仅含轻量五元组且指向 Thread；Thread 列表 API 不暴露完整快照；
6. 并发不变量：更新 Agent（追加新 version）后，运行中/已创建 session 快照与行为不变；
7. `config_hash`：JCS 绑定 + golden vectors 跨 Node/CF 一致；非法值（NaN/Infinity/BigInt）拒绝；`undefined` 移除语义、数组顺序保留、哈希对象=落库对象；
8. **存量迁移**：nullable 加列 → JCS 回填非空历史快照（→ finalized+hash）→ 启用新写入约束三阶段各有序列测试；`agent_snapshot=null` 的 legacy Session 显式分类为 `legacy_unversioned`，不误标 building，且不可作为 CAS 更新起点。

每个用例标 runtime（Node / CF / 共用），禁止互为代表。

## 7. 开放问题（验收/治理参数，无设计级分歧）

1. 委派树治理限制的具体参数（深度/并发/循环检测——层级本身已按绑定补充 1 按 Runtime 各自允许，Node Phase 0 单层、CF 递归）；
2. 目标环境迁移批次、回退窗口与外部模型 E2E 数据集由上线评审确定。

（原事实源机制、canonical JSON 选型、热更新、指针 vs 全量均已裁决，内嵌 §4.4/§4.5。）

## 8. Go-ahead 记录

**2026-08-17 第七轮评审：设计通过，GO-AHEAD 授予**——§6 TDD 启动，先写 RED 测试。实现至 GREEN 后，按验收证据口径复核（规定数据库/runtime 环境实际执行 + 命令、结果与环境记录）。

**RED 首批落地记录（2026-08-17 第八轮）**：新增 `test/unit/agent-snapshot-hash.test.ts`、`test/unit/session-snapshot-lifecycle.test.ts`、`test/unit/session-snapshot-migration.test.ts`、`test/unit/session-snapshot-schema-contract.test.ts`、`test/integration/thread-snapshot-contract.test.ts`；定点扩充 `test/integration/api.test.ts`、`apps/main-node/test/feishu-tables.schema.test.ts`。红灯符合预期：JCS 共用模块缺失；G1 请求历史 version 固化错版 + 不存在 version 返回 201 而非 404；G3 生命周期/CAS 5 用例字段与方法不存在；CF/PG Session 三列与 CF/Node Thread 四列缺失；三阶段回填模块缺失；Node SQLite 实际迁移后仍仅原有 Session/Thread 字段。改动前基线：Session+Thread 53 passed、API 子集 15 passed、Node SQLite schema 34 passed。既存工作区改动未触碰、未写生产代码、未提交。

**GREEN 落地记录（2026-08-17 第九轮）**：

- Schema：CF D1、Node SQLite、Node PG 前向迁移与 Drizzle journal 已生成；三套 `drizzle-kit check` 通过；Node 实际 SQLite 迁移测试通过。
- 哈希：`canonicalize@4.0.0` + WebCrypto SHA-256，共用 `sha256:jcs-rfc8785:v1`；RFC 8785 golden vector、非法值与持久化语义测试通过；CF worker bundling 已越过上传包生成（容器镜像拉取不属于本合同，验证时主动终止）。
- 生命周期：新 Session 进入 building；adapter 以单条条件 `UPDATE ... RETURNING` 的返回行数判定 CAS；通用 update 路径不再允许改写 Agent 快照；CF `/init` 重读存储并只接受 finalized，Node 在实际加载 Agent 时执行同一门。
- 迁移：应用批处理按 tenant+session 条件幂等回填；非空 legacy → JCS hash + finalized，空快照 → legacy_unversioned；Node 滚动升级路径支持惰性单行归类，治理/崩溃恢复不被运行门误伤。
- 版本与委派：`{id, version}` 三分支生效；`call_agent_*` 传播 roster version；CF/Node Thread 保存完整子快照+版本+hash，事件只带轻量证据；Node Phase 0 单层执行，CF 保留递归；列表/详情不返回完整快照。
- 验证命令与结果：`pnpm test` 全绿——根 Cloudflare 122 files / 1753 passed / 17 skipped；ACP 1 passed；session-runtime 34 passed；main-node 109 passed / 26 skipped；cap 256 passed；Node integrations adapter 7 passed；Console 37 passed。`tsc --noEmit`、Node 四包 typecheck、`git diff --check`、test discovery 均通过。
