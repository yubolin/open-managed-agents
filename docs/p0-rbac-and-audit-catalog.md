# Operations RBAC 权限矩阵与审计事件目录 (v0.4)

> 状态：v0.4 · **评审定稿**（2026-08-17）
> 修订记录：
> - v0.4（2026-08-17）：闭合 Review R4-补——审计字典补 `template.version_deactivate` 版本级停用动作（对齐服务模板 spec v0.4 的 `is_active` 生命周期位口径）。
> - v0.3（2026-08-17）：关闭 Review M10-缺、N4/N7；在 §5 负向自动化测试映射中补齐“绕过 BFF 直达服务层鉴权拦截”负向测试用例（M10-缺）；审计信封规范 `resource_version` 结构（N7）。
> - v0.2（2026-08-17）：Admin 无特权、补全待审与返工动作字典、三段相位。
> - v0.1（2026-08-17）：初版草案。
>
> 上游输入：
> - [p0-governance-principles.md](file:///Users/bolin/Documents/git/openma/docs/p0-governance-principles.md)（v0.3：D0 角色模型原则、deny-by-default、SoD 职责分离、统一审计信封、§7 负向测试）
> - [operations-workspace-prd.md](file:///Users/bolin/Documents/git/openma/docs/operations-workspace-prd.md)（v0.4：§3 目标角色、§6 状态机、§10 裁决 6 度量埋点）
> - [p0-run-data-model-spec.md](file:///Users/bolin/Documents/git/openma/docs/p0-run-data-model-spec.md)（v0.3：Run 聚合根与 `run_events` Schema）

---

## 1. 角色模型与职责能力定义

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    租户用户 (Tenant User)               │
                    └───────────┬───────────────────┬─────────────────┬───────┘
                                │                   │                 │
                    ┌───────────▼────────┐  ┌───────▼────────┐ ┌──────▼───────┐
                    │ 申请人 (Applicant) │  │ 审批人(Approver)│ │ 审计员(Auditor)│
                    │ • 浏览服务目录     │  │ • 查看看板待办  │ │ • 只读全量详情│
                    │ • 发起与提交 Run   │  │ • 批准/驳回/修改│ │ • 审计记录检索│
                    │ • 人工干预与取消   │  │ • (受 SoD 约束) │ │ • (P1 后可选) │
                    └────────────────────┘  └────────────────┘ └──────────────┘
                                                    ▲
                                                    │ 互斥约束 (SoD)
                                                    └─ 同一 Run 内禁止同人
```

### 1.1 平台管理员审批权一锤定音
- **平台管理员 (`role_platform_admin`)** 仅拥有服务模板与配置管理权限，**无权直接审批业务 Run (`workspace.approval:decide = ❌`)**；
- 若管理员被分配至某业务审批组（如 `grp_sre_leads`），其必须切换至 `role_approver` 角色进行审批，且**同样受 SoD 约束**，严禁审批自己发起的 Run。

---

## 2. RBAC 权限点矩阵

| 权限点代码 | 申请人 (`role_applicant`) | 审批人 (`role_approver`) | 审计员 (`role_auditor`) | 平台管理员 (`role_platform_admin`) |
|---|:---:|:---:|:---:|:---:|
| `workspace.template:list` | ✅ | ✅ | ✅ | ✅ |
| `workspace.template:read` | ✅ | ✅ | ✅ | ✅ |
| `workspace.run:create` | ✅ | ❌ | ❌ | ✅ |
| `workspace.run:submit` | ✅ | ❌ | ❌ | ✅ |
| `workspace.run:cancel` | ✅ (限本人发起) | ❌ | ❌ | ✅ |
| `workspace.run:list_own` | ✅ | ✅ | ✅ | ✅ |
| `workspace.run:list_all` | ❌ | ✅ | ✅ | ✅ |
| `workspace.run:read_detail`| ✅ (限本人发起) | ✅ (待审及已审) | ✅ (全量) | ✅ (全量) |
| `workspace.run:interrupt` | ✅ (限本人发起) | ❌ | ❌ | ✅ |
| `workspace.approval:list` | ❌ | ✅ | ❌ | ❌ |
| `workspace.approval:decide` | ❌ | ✅ (受 SoD 约束) | ❌ | **❌ (无特权)** |
| `workspace.audit:read` | ❌ | ❌ | ✅ | ✅ |
| `workspace.metric:read` | ❌ | ❌ | ✅ | ✅ |

---

## 3. 统一审计事件目录 (Audit Event Catalog)

| 事件动作 (`action`) | 触发场景 | 资源类型 | 副作用层级 | 相位映射与说明 | 强制扩展字段 (`payload`) |
|---|---|---|---|---|---|
| `run.create` | 创建 Run 草稿 | `run` | 控制面 | `phase=result` | `template_id`, `template_version_id` |
| `run.submit` | 提交 Run 申请 | `run` | 控制面 | `phase=result` | `submitted_at`, `input_parameters_hash` |
| `run.cancel` | 取消 Run 申请 | `run` | 控制面 | `phase=result` | `cancel_reason` |
| `run.plan_start` | 启动排障规划 | `run` | 外部副作用 | `phase=intent` (`result=pending`) | `session_id`, `snapshot_hash` |
| `run.plan_finish`| 规划方案就绪 | `run` | 外部副作用 | `phase=result` | `plan_hash`, `evidence_snapshot_hash`, `duration_ms` |
| `run.await_approval`| 进入待审状态 | `run` | 控制面 | `phase=result` | `plan_hash`, `current_stage` |
| `approval.approve` | **审批人批准方案** | `run` | 控制面 (单事务) | `phase=result` (同事务强一致) | **必填**：`plan_hash`, `evidence_snapshot_hash`, `approver_id`, `stage_order` |
| `approval.reject` | 审批人驳回方案 | `run` | 控制面 (单事务) | `phase=result` | `approver_id`, `comment` |
| `approval.request_changes` | 审批人要求修改 | `run` | 控制面 (单事务) | `phase=result` | `approver_id`, `rework_comments` |
| `approval.invalidate`| 方案漂移审批失效 | `run` | 控制面 | `phase=result` | `invalidated_reason`, `old_plan_hash`, `new_plan_hash` |
| `run.exec_start` | 启动自动化执行 | `run` | 外部副作用 | `phase=intent` (`result=pending`) | `plan_hash`, `approval_id` |
| `run.exec_finish`| 执行终态到达 | `run` | 外部副作用 | `phase=result` | `duration_ms`, `exit_status` |
| `run.interrupt` | 人工干预中断 | `run` | 控制面 | `phase=result` | `operator_id`, `reason` |
| `template.publish`| 发布模板版本 | `template`| 控制面 | `phase=result` | `template_id`, `version_id`, `version` |
| `template.version_deactivate` | **版本级停用**（`is_active=false`，禁止新 Run 绑定，不影响存量 Run 快照） | `template`| 控制面 | `phase=result` | `template_id`, `version_id`, `operator_id`, `deactivate_reason` |
| `template.archive`| 下架服务模板 | `template`| 控制面 | `phase=result` | `template_id`, `archived_by` |

---

## 4. 留存与清理审计规则 (D0 §6 对齐)

1. **不可篡改与不可删除**：`run_events` 仅支持 `INSERT`；
2. **留存期策略**：生产环境默认留存 180 天，核心审批与执行终态事件冷存永久归档；
3. **受控清理 Tombstone**：到期清理产生 `audit.tombstone` 事件记录。

---

## 5. D0 §7 负向自动化测试映射 (补全 M10-缺)

| 测试用例代码 | 测试场景 | 预期断言 | 对应规则 |
|---|---|---|---|
| `TEST_NEG_TENANT_ISOLATION` | 租户 A 用户带 Token 访问租户 B 的 Run | 严格返回 `404 Not Found` | D0 §4 租户不可探测性 |
| `TEST_NEG_SOD_SELF_APPROVAL` | 申请人尝试调用审批接口批准自己的 Run | 严格返回 `403 Forbidden` (`SOD_VIOLATION_SELF_APPROVAL_FORBIDDEN`) | D0 §3 职责分离硬约束 |
| `TEST_NEG_ADMIN_APPROVAL_BYPASS` | 平台管理员尝试利用 Admin Token 审批业务 Run | 严格返回 `403 Forbidden` | RBAC §1.1 平台管理员无业务特权 |
| `TEST_NEG_BYPASS_BFF_DIRECT_SERVICE_INVOCATION` | **绕过 BFF 直调底层 Domain/ApprovalService 接口 (M10-缺)** | 领域服务层鉴权中间件拦截并抛出 `UnauthorizedError` / `ForbiddenError` | **D0 §2 鉴权在每个可信边界执行 (Fail-Closed)** |
| `TEST_NEG_CAS_PLAN_DRIFT` | 方案在审批后发生变动，尝试直接触发执行 | 原子迁移至 `approval_invalidated` 并返回 `409 Conflict` (`PLAN_HASH_DRIFT_INVALIDATED`) | K2 / H1 执行门禁 CAS |
| `TEST_NEG_CAS_EVIDENCE_DRIFT` | 证据集在审批后发生变动，尝试直接触发执行 | 原子迁移至 `approval_invalidated` 并返回 `409 Conflict` (`EVIDENCE_HASH_DRIFT_INVALIDATED`) | K2 / H1 证据防偷换 CAS |
| `TEST_NEG_AUDIT_MISSING_REQUIRED` | 尝试写入缺失 `tenant_id` 或 `actor` 的审计记录 | 数据库层/服务层拒绝写入并抛出 `ValidationError` (`AUDIT_MISSING_REQUIRED_FIELD`) | D0 §5 必填缺失拒写入 |
