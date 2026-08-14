# AIOps Closed-Loop Operations Ecosystem

The enterprise-privatization AIOps line built on Open Managed Agents as the
agent foundation. This is the "AIOps plan" referenced by
`packages/aiops/src/store.ts` and the feature modules in `apps/main-node/src/lib/`.
Base: `main` @ `df81806`.

## 愿景与五项需求

Use OpenMA as the agent substrate for a unified operations ecosystem —
digital employees + Console UI + integrations to observability, patching,
provisioning, ITSM, CMDB, and automation:

| # | Requirement | Where it lives |
|---|---|---|
| 1 | AI-driven planning / recommendation / validation for provisioning, change, patch, remediation | Triage protocol (`packages/aiops/src/signal.ts`) + digital employees (Phase 3 expands the roster) |
| 2 | Collaborate with CMP Automation / ITSM / CMDB / ops-data services | `packages/cmp` contract + `cmp-agent-tools.ts` |
| 3 | Intelligent analysis of events/alerts/logs/telemetry: correlation, anomaly, relationship identification | Fingerprint dedup + occurrence folding (sweeper + ingest) + in-session LLM analysis via `opsdata`/`cmdb` tools |
| 4 | Alert priority judgment + automated response | Severity escalation on dedup; priority policy via triage protocol; approval-gated automation |
| 5 | Closed loop: alert → analysis → recommendation → approval → execution → ITSM write-back | The full pipeline below |

## 架构总览

```
Alertmanager / zabbix / generic webhook
        │  POST /v1/aiops/alerts   (x-api-key, tenant-scoped, shape-sniffed)
        ▼
   normalize → insertDedup ──resolved──► markResolved + alert_resolved signal
        │  (status=new)
        ▼  aiops-dispatch cron (claimNew, statement-atomic, multi-replica safe)
   ┌─ no open session for fingerprint ─┐   ┌─ open session exists ─┐
   │ create triage session             │   │ alert_occurrence      │
   │ + renderAlertSignal (user.message)│   │ signal into session   │
   └───────────────┬───────────────────┘   └───────────────────────┘
                   ▼
   alert-triage-operator (digital employee)
     cmp__cmdb_lookup → cmp__itsm_ticket_create → recommendation
     → cmp__automation_request_approval → ends turn
                   ▼
   Human decides: Console approvals page / POST /v1/aiops/approvals/:id/decide
     (human-only: user-scoped principal required; agent keys get 403)
                   ▼
   Decision continuation re-enters the session (user.message)
     approved → cmp__automation_execute (server-side gate) → cmp__itsm_ticket_append
     rejected → write-back of the refusal, close out
                   ▼
   ITSM ticket carries the loop; alert lifecycle ends with resolution signal
```

Ingest handles three signal cases immediately (no sweeper round-trip):
`resolved` payloads mark the alert resolved and notify its session; in-window
dedup folds into an already-dispatched alert resume its session with an
`alert_occurrence` signal.

## 组件映射

| Piece | File | Notes |
|---|---|---|
| Domain, store port, normalizers, fingerprint, signals | `packages/aiops/src/*` | Upstream-shareable; `test-fakes.ts` is the reference implementation the SQL adapter must mirror |
| Dispatch tick factory | `packages/aiops/src/dispatch.ts` | Kept in the aiops package so `packages/scheduler` stays untouched (see §升级隔离) |
| SQL alert adapter | `apps/main-node/src/lib/aiops-alert-store.ts` | `insertDedup` / `claimNew` (CTE `UPDATE … RETURNING`, both dialects) / lifecycle; `listForTenant` is a local extension |
| Approval store | `apps/main-node/src/lib/approval-store.ts` | create / list / decide (guarded conditional UPDATE) / `expireStale` |
| Gated CMP tools | `apps/main-node/src/lib/cmp-agent-tools.ts` | 7 tools; execute refuses without a matching approved record |
| Subsystem composition | `apps/main-node/src/lib/aiops-subsystem.ts` | Stores + fake connector + sweeper + Hono routes + cron jobs, all in one register function |
| Host wiring | `apps/main-node/src/index.ts` | One gated block (`AIOPS_ENABLED=1`): dynamic import, mount `/v1/aiops`, `extraJobs` |
| Scheduler hook | `apps/main-node/src/lib/node-scheduler-jobs.ts` | Generic optional `extraJobs` dep; per-job `<JOB>_CRON` env override |
| Digital-employee seed | `scripts/seed-aiops-operators.ts` | `alert-triage-operator` via REST `POST /v1/agents` |
| Console views | `apps/console/src/plugins/aiops/` (`AlertsPage`, `ApprovalsPage`, plugin `index`) | Alert list + approval queue, built on the console plugin extension point (§升级隔离) |

Migrations (journal-only, no drizzle snapshot — freeze-gate precedent):

- `aiops_alerts` — Phase 1, dual-dialect (already on `main`)
- `approval_requests` — sqlite `0006_add_approval_requests.sql`, pg `0007_add_approval_requests.sql`; `status CHECK (pending|approved|rejected|expired)`; indexes on `(tenant_id, status)`, `(tenant_id, expires_at)`, `(session_id)`

## 分诊协议与信号

`packages/aiops/src/signal.ts` owns both the protocol prompt
(`AIOPS_TRIAGE_PROTOCOL_PROMPT`: 解析 → CMDB 定位 → 查重 → 建单/补单 → 建议 →
提请审批) and the envelope renderers injected as `user.message` turns:

- `alert_fired` — new triage session (sweeper)
- `alert_occurrence` — same fingerprint while an open session exists (sweeper resume, or ingest-time dedup fold)
- `alert_resolved` — recovery: operator closes out and annotates the ITSM ticket

## CMP 接入面

**Decision: contract-first** (user choice). `packages/cmp` defines
`CmpConnector` with four namespaces — `cmdb` (entity/relationship lookup),
`itsm` (ticket create/append/status), `automation` (runbook list / dry-run /
execute / status), `opsdata` (metrics/logs/events) — with zod-validated
request/response types and an in-memory fake (`FakeCmpConnector`,
`autoComplete` mode + seeded runbooks `rb_restart_service` / `rb_scale_out` /
`rb_disk_clean`) for dev and tests.

The subsystem constructs the fake at exactly one line
(`aiops-subsystem.ts`); when the real CMP HTTP spec arrives, a
`HttpCmpConnector` implementing the same port replaces it there. Credentials
for the real adapter must flow through vaults (`static_bearer` /
`command_secret`) per `docs/secrets-design.md` — never env vars.

Agent tools (only mounted for agents with
`metadata.kind === "digital_employee"` and `metadata.domain === "aiops"`):

| Tool | Gate |
|---|---|
| `cmp__cmdb_lookup` | read-only |
| `cmp__itsm_ticket_create` / `cmp__itsm_ticket_append` | writes audited tickets |
| `cmp__automation_list` | read-only |
| `cmp__automation_request_approval` | creates a **pending** approval; never executes |
| `cmp__automation_execute` | **refuses** without an approved record for this session + this runbook + unexpired (server-side check; no agent-suppliable bypass) |
| `cmp__automation_execution_status` | read-only |

## 审批门禁（安全模型）

Agents **create** approval requests; only **humans decide**. Records in
`approval_requests` are the source of truth; Console (and a future Feishu
approval card, Phase 2.5) are views over them.

1. **Human-only decide** — `POST /v1/aiops/approvals/:id/decide` requires a
   user-scoped principal (`c.var.user_id`); tenant-wide agent API keys get
   `403`. With `AUTH_DISABLED=1` (local dev), decisions record as
   `decided_by = "dev-user"` — documented dev bypass, never enable it in prod.
2. **Server-side execute gate** — `cmp__automation_execute` verifies on every
   call: the approval exists, belongs to *this session*, matches *this
   runbook*, is `approved`, and is unexpired. `expires_at` is enforced both at
   decide-time and by the `aiops-approval-expiry` tick (`expireStale`).
3. **Continuation, not side-effect** — approving/rejecting appends a
   `user.message` to the triage session telling the operator to execute (or
   stand down) and write the result back to ITSM. The loop's next step is
   always a fresh agent turn the human can watch.

## 数字员工

`alert-triage-operator` — the Phase-1/2 operator. Seed:

```bash
BASE=http://localhost:8787 KEY=<x-api-key> ./scripts/seed-aiops-operators.ts
# re-seed a new version: … seed-aiops-operators.ts --force
```

The system prompt embeds `AIOPS_TRIAGE_PROTOCOL_PROMPT` (imported from
`packages/aiops/src/signal.ts` so prompt and renderers evolve together) plus
the CMP tool guidance. Metadata `{ kind: "digital_employee", domain: "aiops" }`
is what gates the CMP toolset. Sessions bind the agent version at creation —
re-seeding creates a new version; open sessions finish on the old one
(standard OpenMA versioning).

Phase 3 adds `change-planner`, `patch-ops`, `provisioning-ops`,
`remediation-specialist` via the same script pattern, with the triage
operator delegating through `callable_agents`.

## API 参考

All routes tenant-scoped by `x-api-key`; mounted under `/v1/aiops` and only
when `AIOPS_ENABLED=1`.

| Route | Description |
|---|---|
| `POST /v1/aiops/alerts` | Webhook ingress. Body shape-sniffed (alertmanager / zabbix / generic) by `normalizeAlertPayload`; `201 {accepted, results:[{alert_id, deduped, resolved}]}`; malformed → `400` |
| `GET /v1/aiops/alerts?severity=&status=&limit=` | Alert list (Console view); snake_case rows |
| `GET /v1/aiops/approvals?status=&limit=` | Approval queue (default `pending`) |
| `POST /v1/aiops/approvals/:id/decide` | `{decision: "approve"\|"reject", reason?}` → `200 {approval}` / `403` non-human / `404` missing / `409` decided-or-expired |

## 环境变量

| Var | Default | Meaning |
|---|---|---|
| `AIOPS_ENABLED` | unset (off) | Mount routes, register tools + cron jobs. **Off = zero behavior change vs upstream** |
| `AIOPS_DISPATCH_CRON` | `* * * * *` | Dispatch sweeper schedule |
| `AIOPS_APPROVAL_EXPIRY_CRON` | `* * * * *` | Stale-approval expiry tick |
| `AIOPS_DEDUP_WINDOW_MS` | `900000` | Fingerprint dedup window |
| `AIOPS_TRIAGE_AGENT_ID` | — | Pin the triage agent explicitly |
| `AIOPS_TRIAGE_AGENT_NAME` | `alert-triage-operator` | Resolve by name (cached per tenant) |

## 升级隔离

Hard constraint from the product owner: **openma upgrades must stay clean —
enterprise customization must not destabilize the platform**. Rules the
implementation follows (and new AIOps code must keep following):

1. **Single composition point.** Everything enterprise-side composes inside
   `registerAiopsSubsystem()`; it receives structural dep slices and never
   imports `index.ts` internals, and no upstream file imports from it.
2. **Shared files get gated, minimal hunks.** The complete upstream-merge
   conflict surface is:
   - `apps/main-node/src/index.ts` — imports; the `buildHarnessContext`
     `resolveCmpAgentTools` call + spread; the `AIOPS_ENABLED` block (dynamic
     import + mount + jobs var); `extraJobs` in the scheduler deps.
   - `apps/main-node/src/lib/node-scheduler-jobs.ts` — optional `extraJobs`
     dep + generic registration loop.
   - `apps/main-node/package.json` — two workspace deps
     (`@open-managed-agents/aiops`, `@open-managed-agents/cmp`).
   - `apps/console/src/plugins/registry.ts` — the `aiopsPlugin` import +
     registration in the `consolePlugins` array. The AIOps pages
     themselves are plugin files (`apps/console/src/plugins/aiops/`) using
     the designed extension point — `main.tsx`, `AppSidebar.tsx`, and the
     i18n bundles are untouched. Hosted builds that overlay-replace
     `registry.ts` must preserve the registration.
   Everything else is new files → merge-clean by construction.
3. **No upstream-shared package is modified for wiring.** The dispatch tick
   lives in `packages/aiops` (not `packages/scheduler`); the scheduler got a
   *generic* `extraJobs` hook rather than an aiops-specific dependency;
   tenant-scoped alert listing is a local `listForTenant` extension instead
   of a port change.
4. **Default-off.** With `AIOPS_ENABLED` unset there are no routes, no tools,
   no jobs — upstream behavior byte-for-byte.
5. **Additive schema only.** New tables, journal-only migrations (no drizzle
   snapshot churn, freeze-gate precedent), never an upstream-table ALTER.
6. **Fake at one line.** The CMP connector choice is a single constructor
   call; swapping in the real adapter touches nothing else.

Upstream-merge procedure for this line: merge `main`, resolve the four
indexed hunks above (mechanical — keep both sides), run
`pnpm --filter main-node test && pnpm -r typecheck`. If upstream changes the
scheduler deps or harness-context shape, the structural slices in
`AiopsSubsystemDeps` absorb it locally.

## Phase 映射

- **Phase 1 (done)** — alert closed loop MVP: SQL adapter, webhook ingress +
  Console API, dispatch sweeper + wiring, digital-employee seed, this doc.
- **Phase 2 (done)** — CMP contract layer + approval gate: `packages/cmp`,
  gated tools, `approval_requests` + stores + REST + expiry, decide →
  execute → ITSM write-back continuation, Console pages.
- **Phase 2.5 (optional)** — Feishu approval-card *view* over the same
  approval records (records stay the source of truth).
- **Phase 3 (incremental)** — more digital employees via `callable_agents`
  delegation; `opsdata`-driven correlation depth (LLM-first, ML out of
  scope); priority policy: allow-list of low-risk auto-executable runbooks
  (post-hoc audit) vs approval-required default; Console digital-employee
  gallery + closed-loop audit view; Feishu publications for human personas.

## 测试策略

- `packages/cmp/test/cmp.test.ts` — contract + fake semantics (10 tests).
- `apps/main-node/test/aiops-alert-store.test.ts` — SQL adapter mirrors the
  reference fake; multi-replica `claimNew` exclusivity (8 tests).
- `apps/main-node/test/aiops-subsystem.test.ts` — the full loop against real
  sqlite migrations: ingress → dedup → sweep → approval security (agent key
  403, human approve/reject, 409s, expiry) → server-side execute gate (16
  tests).

## 本地体验

```bash
# 1. boot main-node with the loop enabled
AIOPS_ENABLED=1 pnpm --filter main-node dev

# 2. seed the operator (needs a key with agent scope)
BASE=http://localhost:8787 KEY=<key> ./scripts/seed-aiops-operators.ts

# 3. fire an alert (alertmanager shape)
curl -s http://localhost:8787/v1/aiops/alerts -H "x-api-key: $KEY" \
  -H 'content-type: application/json' -d '{
    "alerts":[{"status":"firing","labels":{"alertname":"HighCPU","host":"web-01","severity":"warning"},
    "annotations":{"summary":"CPU 95%"},"startsAt":"2026-08-14T00:00:00Z","fingerprint":"fp_demo_1"}]}'
# → within a minute the dispatcher opens a triage session (Console → Sessions)

# 4. when the operator requests approval, decide it (user-scoped key)
curl -s http://localhost:8787/v1/aiops/approvals -H "x-api-key: $KEY"          # find the id
curl -s -X POST http://localhost:8787/v1/aiops/approvals/<id>/decide \
  -H "x-api-key: $USER_KEY" -H 'content-type: application/json' \
  -d '{"decision":"approve"}'
# → the session continues: execute (gated) → ITSM write-back
```

## Out of scope (explicitly)

Real CMP HTTP adapter (until a spec arrives), Feishu approval-card rendering
(Phase 2.5 view only), ML-based anomaly detection, multi-region /
leader-election for the sweeper (claim-based safety suffices, same stance as
linear-dispatch).
