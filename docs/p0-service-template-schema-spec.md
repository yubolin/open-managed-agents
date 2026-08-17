# Operations 服务模板 Schema Spec (v0.4)

> 状态：v0.4 · **评审定稿**（2026-08-17）
> 修订记录：
> - v0.4（2026-08-17）：闭合 Review R3/R4——§2.3 明确版本表"内容不可变、`is_active` 为唯一生命周期位"口径（停用=禁止新 Run 绑定、不影响存量 Run，翻转留 `template.version_deactivate` 审计）；超时终局语义与 PRD v0.5 §6 `cancelled` 注释对齐（按策略系统取消或人工取消，均留审计）。
> - v0.3（2026-08-17）：关闭 Review N2、M8-半；将 `fallback_to_tenant_admin` 修正为 `fallback_to_default_group`（兜底派发至租户默认审批组 `grp_tenant_default_approvers`，彻底消除与 Admin decide=❌ 的矛盾，修复 N2）；明确 `template_version_id` 服务端解析与校验规则（M8-半）。
> - v0.2（2026-08-17）：关闭 H3、H6、M7、M9；重构分级审批组，删除 rules 动态路由，确定 Seed 机制。
> - v0.1（2026-08-17）：初版草案。
>
> 上游输入：
> - [operations-workspace-prd.md](file:///Users/bolin/Documents/git/openma/docs/operations-workspace-prd.md)（v0.4：§4 旅程 1、§7 K1、§10 裁决 1/2/5）
> - [p0-governance-principles.md](file:///Users/bolin/Documents/git/openma/docs/p0-governance-principles.md)（v0.3：D0 租户所有权、SoD 约束、统一审计）
> - [p0-run-data-model-spec.md](file:///Users/bolin/Documents/git/openma/docs/p0-run-data-model-spec.md)（v0.3：Run 聚合根与分级审批阶段）

---

## 1. 架构定位与版本解析规则

```
                                  平台管理面 (Console)
                                         │
                                  定义 / 发布模板
                                         │
                                         ▼
                 ┌───────────────────────────────────────────────┐
                 │     service_templates (模板元数据主表)        │
                 │   - tenant_id (D0 强所有权)                   │
                 │   - code (租户内唯一代码，Seed 导入)          │
                 │   - current_version_id (当前生效发布版本)     │
                 └───────────────────────┬───────────────────────┘
                                         │ 1:N 发布不可变版本
                                         ▼
                 ┌───────────────────────────────────────────────┐
                 │  service_template_versions (不可变快照版本)   │
                 │   - version (单调递增整数: 1, 2, 3...)        │
                 │   - is_active (是否允许新申请绑定)            │
                 │   - agent_binding: { agent_id, version } (K1) │
                 │   - form_schema (JSON Schema + UI Hints)      │
                 │   - approval_policy (分级审批组模型，裁决 1)   │
                 │   - timeout_policy (超时升级通知，裁决 5)     │
                 └───────────────────────┬───────────────────────┘
                                         │ 1:N 实例化申请
                                         ▼
                                  Run 聚合根 (runs)
```

### 1.1 版本绑定与解析规则 (对齐 M8-半)
- **缺省情况**：创建 Run 请求若未显式传递 `template_version_id`，服务端默认绑定模板主表当前的 `current_version_id`；
- **显式指定**：创建 Run 请求若携带了 `template_version_id`，服务端执行强校验：
  1. 断言该版本所属 `template_id` 与请求一致；
  2. 断言该版本状态为 `is_active = true`（已发布的活跃版本）；
  3. 若版本不存在或已被下架（`is_active = false`），服务端返回 `400 Bad Request (INACTIVE_OR_INVALID_TEMPLATE_VERSION)`，禁止随意钉死已废弃的旧版本。

---

## 2. 存储落位与 Schema 设计

### 2.1 落位目录 (三店镜像)
- `packages/db-schema/src/cf-auth/operations.ts`（D1）
- `packages/db-schema/src/node-sqlite/operations.ts`（SQLite）
- `packages/db-schema/src/node-pg/operations.ts`（PG）

### 2.2 `service_templates` 模板主表

| 字段 | 类型 | 必填 | 约束 / 索引 | 说明 |
|---|---|---|---|---|
| `id` | `VARCHAR(64)` | 是 | PK | 前缀 `stpl_` |
| `tenant_id` | `VARCHAR(64)` | 是 | INDEX | 租户隔离标识 |
| `name` | `VARCHAR(128)` | 是 | | 模板名称（如“K8s 故障只读诊断”） |
| `code` | `VARCHAR(64)` | 是 | UNIQUE (`tenant_id`, `code`) | 租户内唯一代码（Seed 导入） |
| `category` | `VARCHAR(32)` | 是 | INDEX | 类别：`diagnostic` \| `change_plan` |
| `description` | `TEXT` | 否 | | 详细使用说明 |
| `is_active` | `BOOLEAN` / `INT` | 是 | DEFAULT 1 | 是否上架可用 |
| `current_version_id` | `VARCHAR(64)` | 否 | | 当前生效的版本 ID |
| `created_by` | `VARCHAR(64)` | 是 | | 创建者 User ID |
| `created_at` | `BIGINT` | 是 | INDEX | 创建时间戳（ms） |
| `updated_at` | `BIGINT` | 是 | | 更新时间戳（ms） |

### 2.3 `service_template_versions` 模板版本表 (不可变)

| 字段 | 类型 | 必填 | 约束 / 索引 | 说明 |
|---|---|---|---|---|
| `id` | `VARCHAR(64)` | 是 | PK | 前缀 `stplv_` |
| `template_id` | `VARCHAR(64)` | 是 | INDEX | 所属模板 ID |
| `tenant_id` | `VARCHAR(64)` | 是 | INDEX | 复合外键租户 ID |
| `version` | `INT` | 是 | UNIQUE (`template_id`, `version`) | 单调递增版本号 |
| `is_active` | `BOOLEAN` / `INT` | 是 | DEFAULT 1 | 是否允许新 Run 绑定 |
| `agent_binding` | `TEXT` (JSON) | 是 | | 底层 Agent 绑定 |
| `form_schema` | `TEXT` (JSON) | 是 | | 申请表单 JSON Schema |
| `ui_schema` | `TEXT` (JSON) | 否 | | 前端渲染提示 |
| `approval_policy` | `TEXT` (JSON) | 是 | | 分级审批组策略（见 §3.3，修复 N2） |
| `timeout_policy` | `TEXT` (JSON) | 是 | | 超时升级策略 |
| `changelog` | `TEXT` | 否 | | 版本更新日志 |
| `published_by` | `VARCHAR(64)` | 是 | | 发布人 User ID |
| `published_at` | `BIGINT` | 是 | INDEX | 发布时间戳（ms） |

**外键约束**：
- `FOREIGN KEY (tenant_id, template_id) REFERENCES service_templates(tenant_id, id) ON DELETE CASCADE`

**不可变口径 (R4)**：`agent_binding` / `form_schema` / `ui_schema` / `approval_policy` / `timeout_policy` 等内容字段**发布后严禁修改**——需要变更即发布新版本行（`version + 1`）；`is_active` 为**唯一允许翻转的生命周期位**（停用 = 禁止新 Run 绑定，不影响存量 Run 的 K1 快照），每次翻转必须留 `template.version_deactivate` 审计事件（见 RBAC 审计目录 v0.4）。

---

## 3. 核心配置规范

### 3.1 分级审批组策略 Schema (`approval_policy`, 修复 N2)

> 💡 **修复说明 (N2)**：彻底消除与 Admin `decide=❌` 矛盾的 `fallback_to_tenant_admin`；改为 **`fallback_to_default_group: true`**（当指定组无人或未配置时，兜底派发至租户默认审批组 `grp_tenant_default_approvers`，其中成员均持 `role_approver` 角色且受 SoD 约束）。

```json
{
  "mode": "sequential_groups",
  "stages": [
    {
      "stage_order": 1,
      "stage_name": "SRE 核心值班组初审",
      "group_id": "grp_sre_leads",
      "required_approvals": 1
    },
    {
      "stage_order": 2,
      "stage_name": "业务负责人复核",
      "group_id": "grp_service_owners",
      "required_approvals": 1
    }
  ],
  "fallback_to_default_group": true,
  "default_group_id": "grp_tenant_default_approvers"
}
```

### 3.2 超时升级策略 Schema (`timeout_policy`)

```json
{
  "approval_timeout_minutes": 60,
  "escalation_interval_minutes": 15,
  "escalation_actions": [
    {
      "at_minute": 15,
      "action": "notify_feishu_group",
      "target": "oc_feishu_sre_duty_chat"
    },
    {
      "at_minute": 30,
      "action": "notify_process_owner",
      "channel": "feishu_direct_message"
    },
    {
      "at_minute": 60,
      "action": "mark_approval_overdue_and_cancel",
      "final_state_behavior": "cancelled"
    }
  ]
}
```

> **R3 对齐说明**：超时终局 `mark_approval_overdue_and_cancel` 为**系统发起的取消动作**（等价于"人工取消"的另一种触发方式），Run 迁移至 `cancelled` 并留 `run.cancel` 审计（payload 标注 `cancel_reason: approval_timeout`）；与 PRD v0.5 §6 `cancelled` 语义注释一致。**任何超时路径都不存在自动批准通道**（裁决 5 / D0）。

---

## 4. 首发预置模板定义 (PRD §10 裁决 2)

### 4.1 模板 1 · 只读故障诊断 (`readonly_fault_diagnosis`)
- **定位**：线上异常只读排查；
- **审批策略**：单级审批，`stages: [{ stage_order: 1, group_id: "grp_sre_leads", required_approvals: 1 }]`；
- **超时策略**：30 分钟超时升级通知。

### 4.2 模板 2 · 受控变更规划 (`controlled_change_planning`)
- **定位**：变更方案制定与影响面分析；
- **审批策略**：两级分级审批（Stage 1: SRE Lead 组，Stage 2: 业务负责人组），严格 SoD；
- **超时策略**：120 分钟超时升级通知。
