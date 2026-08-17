// SessionRegistry — Node thin shell around the unified SessionStateMachine.
//
// One SessionRegistry per process; one SessionStateMachine per active
// session, lazily created on first request. The shell's job is:
//
//   1. Hold the per-process deps (sql, hub, services, env-derived
//      config) in its closure.
//   2. Lazily build a SessionStateMachine on first access. The machine
//      itself owns the per-session sandbox + adapter.
//   3. Run a one-shot bootstrap() at process start to wake any session
//      whose row was left status='running' by a prior process (orphan
//      recovery via the unified machine.onWake path).
//
// Mirrors what apps/agent's SessionDO will become in Phase 3 (a thin
// shell around the same machine, with `alarm()` instead of bootstrap()
// as the orphan-detection trigger).
//
// Sandbox provisioning (memory mounts, /mnt/session/outputs, vault
// outbound, optional workspace-restore) is delegated to the
// SandboxOrchestrator from `@open-managed-agents/sandbox/orchestrator`
// — same interface CF wires for the OmaSandbox path. Per-runtime
// mounters were removed in P5.

import { join } from "node:path";
import {
  RuntimeAdapterImpl,
  SessionStateMachine,
} from "@open-managed-agents/session-runtime";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { SqlStreamRepo, type SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type {
  OrchestratorMemoryMount,
  SandboxOrchestrator,
} from "@open-managed-agents/sandbox/orchestrator";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { MemoryStoreService } from "@open-managed-agents/memory-store";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { extractTextFromContent, hashJsonSnapshot } from "@open-managed-agents/shared";
import type { LanguageModel } from "ai";
import { getLogger } from "@open-managed-agents/observability";
import type { EventStreamHub } from "./lib/event-stream-hub.js";
import {
  remindersFromMounts,
  type MemoryReminder,
} from "./lib/memory-reminders.js";

const log = getLogger("session-registry");

export interface SessionRegistryDeps {
  sql: SqlClient;
  hub: EventStreamHub;
  agentsService: AgentService;
  memoryService: MemoryStoreService;
  /** Sandbox provisioning — vault outbound, mounts, backup-restore.
   *  Replaces the per-runtime buildMemoryMounter / buildSessionOutputsMounter
   *  hooks from before P5. */
  sandboxOrchestrator: SandboxOrchestrator;

  /** Build the per-session event log. Mirrors main-node's existing
   *  newEventLog(sid) — keeps the stamp closure local to the shell. */
  newEventLog(sessionId: string): SqlEventLog;

  /** Build the per-session sandbox. The shell knows how to assemble a
   *  LocalSubprocess / E2B / Daytona / etc., the machine doesn't. */
  buildSandbox(sessionId: string, workdir: string): Promise<SandboxExecutor>;

  /** Build the LanguageModel for the agent. Reads env / model cards,
   *  applies custom headers, picks the right provider. Async when the
   *  shell looks up a model card by handle. */
  buildModel(
    agent: AgentConfig,
    tenantId: string,
  ): LanguageModel | Promise<LanguageModel>;

  /** Build harness tools. Returns the tools dict the harness expects. */
  buildTools(
    agent: AgentConfig,
    sandbox: SandboxExecutor,
    tenantId: string,
    sessionId: string,
    delegateToAgent?: (agentId: string, message: string, version?: number) => Promise<string>,
  ): Promise<unknown>;

  /** Build harness instance + context. Each is platform-neutral so the
   *  machine just calls .run(ctx). */
  buildHarness(): { run: (ctx: unknown) => Promise<void> };
  buildHarnessContext(input: {
    agent: AgentConfig;
    userMessage: UserMessageEvent;
    sandbox: SandboxExecutor;
    tools: unknown;
    model: LanguageModel;
    sessionId: string;
    tenantId: string;
    eventLog: SqlEventLog;
    /** Memory reminders frozen at build() time — derived from the exact
     *  mount list this machine provisioned (no per-turn re-read: bindings
     *  added after build are rejected with 409 by the binding routes). */
    memoryReminders: MemoryReminder[];
    sessionThreadId?: string;
  }): Promise<unknown>;

  /** Sandbox workdir root, e.g. /app/data/sandboxes. Per-session dirs
   *  are joined under it. */
  sandboxWorkdirRoot: string;

  /** SQL dialect under the SqlClient. Threaded through to SqlStreamRepo
   *  so its appendChunk picks the right JSON-array append (json_insert
   *  on sqlite, jsonb concat on postgres). */
  sqlDialect?: "sqlite" | "postgres";
}

interface SessionEntry {
  machine: SessionStateMachine;
  sandbox: SandboxExecutor;
  eventLog: SqlEventLog;
}

export class SessionRegistry {
  private map = new Map<string, Promise<SessionEntry>>();
  /** Per-session serialization for the bind-vs-freeze race (TOCTOU).
   *  Both build() (via getOrCreate) and bindMemoryStore run under this
   *  lock, so a binding write and the build-time snapshot read can never
   *  interleave: a bind either lands BEFORE build reads the table (and is
   *  mounted + reminded) or is rejected with a conflict. */
  private sessionLocks = new Map<string, Promise<unknown>>();

  constructor(private deps: SessionRegistryDeps) {}

  private withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    // Bounded like `map` itself: one entry per session ever touched in
    // this process.
    this.sessionLocks.set(sessionId, run.catch(() => undefined));
    return run;
  }

  /**
   * Get-or-create the SessionStateMachine for a session. Lazy: the
   * sandbox + adapter aren't built until first access. Cached: the same
   * machine is reused across HTTP requests (so chokidar watcher /
   * recovery / repeated user.messages all hit the same in-memory state).
   */
  async getOrCreate(sessionId: string, tenantId: string): Promise<SessionEntry> {
    let p = this.map.get(sessionId);
    if (!p) {
      // map.set happens synchronously BEFORE the locked build is queued:
      // from that instant isBuilt() returns true, so a concurrent
      // bindMemoryStore either already committed (build will see it) or
      // gets a conflict — never a silent drift.
      p = this.withSessionLock(sessionId, () => this.build(sessionId, tenantId));
      // Identity-safe rejection cleanup: a failed build (transient
      // sandbox / mount / model error) must NOT leave the session
      // permanently "built". Only delete if the map still holds THIS
      // promise — never a successor. build() itself clears the DB-level
      // freeze flag on failure, so a retry can also accept new binds.
      void p.catch(() => {
        if (this.map.get(sessionId) === p) this.map.delete(sessionId);
      });
      this.map.set(sessionId, p);
    }
    return p;
  }

  /**
   * Bind-or-freeze gate for POST /v1/sessions/:id/memory_stores.
   *
   * Two layers, both required:
   *  1. In-process: serialized with build() per session via the session
   *     lock + map.has fast path — closes the check-then-write TOCTOU a
   *     plain route-level boolean check would leave open.
   *  2. Database: the INSERT runs as a single conditional statement that
   *     only lands while `sessions.memory_frozen_at IS NULL`. build()
   *     sets that flag BEFORE reading the binding list, so across PG
   *     replicas (no sticky routing required) a bind either commits
   *     before every replica's freeze-read (and is mounted + reminded)
   *     or is rejected — a replica with an empty in-process map can
   *     never accept a post-freeze bind.
   *
   * Returns "bound" (201), "frozen" (409), or "store_not_found" (404).
   * Store validation happens inside the serialized section so a 201
   * never persists a row for a store that didn't exist at bind time.
   */
  async bindMemoryStore(opts: {
    sessionId: string;
    tenantId: string;
    storeId: string;
    access: "read_write" | "read_only";
  }): Promise<"bound" | "frozen" | "store_not_found"> {
    return this.withSessionLock(opts.sessionId, async () => {
      if (this.map.has(opts.sessionId)) return "frozen";
      const store = await this.deps.memoryService.getStore({
        tenantId: opts.tenantId,
        storeId: opts.storeId,
      });
      if (!store) return "store_not_found";
      // Single atomic statement — valid in both dialects. The NOT EXISTS
      // guard reads the persisted freeze flag, so the outcome is decided
      // by the database, not by this process's view of the world.
      const r = await this.deps.sql
        .prepare(
          `INSERT INTO session_memory_stores (session_id, store_id, access, created_at)
           SELECT ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM sessions WHERE id = ? AND memory_frozen_at IS NOT NULL
            )
           ON CONFLICT(session_id, store_id) DO UPDATE SET access = excluded.access`,
        )
        .bind(opts.sessionId, opts.storeId, opts.access, Date.now(), opts.sessionId)
        .run();
      return r.meta.changes > 0 ? "bound" : "frozen";
    });
  }

  /**
   * Process-startup orphan reconciliation. Reads sessions WHERE
   * status='running' and calls onWake() on each. Survivors of a prior
   * crash get their event log cleaned up (placeholder agent.message +
   * tool_result events injected) and the row flips back to 'idle'.
   *
   * No automatic re-execution of the interrupted turn — the user gets
   * a clean state and can retry by sending a new user.message. Mirrors
   * what apps/main-node did inline before this refactor.
   */
  async bootstrap(): Promise<void> {
    const r = await this.deps.sql
      .prepare(
        `SELECT id, tenant_id FROM sessions WHERE status='running' AND turn_id IS NOT NULL`,
      )
      .all<{ id: string; tenant_id: string }>();
    const rows = r.results ?? [];
    if (rows.length === 0) return;
    log.info({ op: "session_registry.bootstrap", recovering: rows.length }, `bootstrap: recovering ${rows.length} interrupted session(s)`);
    for (const row of rows) {
      try {
        const entry = await this.getOrCreate(row.id, row.tenant_id);
        await entry.machine.onWake();
      } catch (err) {
        log.error(
          { err, op: "session_registry.bootstrap.on_wake_failed", session_id: row.id },
          `bootstrap onWake(${row.id}) failed`,
        );
      }
    }
  }

  /**
   * Tear down all in-process sessions on shutdown. Best-effort; the
   * sessions row stays as-is (status='idle' for normal exits, status=
   * 'running' for kill -9, which the next bootstrap will handle).
   */
  async shutdown(): Promise<void> {
    for (const p of this.map.values()) {
      try {
        const entry = await p;
        if (entry.sandbox.destroy) await entry.sandbox.destroy();
      } catch {
        /* best-effort */
      }
    }
    this.map.clear();
  }

  /**
   * Abort the in-flight harness for a session. Routed from
   * POST /v1/sessions/:id/events when the body contains a `user.interrupt`
   * event. No-op if the session has no machine yet (nothing to interrupt).
   * The machine's adapter handles emitting the session-side
   * agent.message_stream_end(status="aborted") event chain.
   */
  interrupt(sessionId: string): void {
    const p = this.map.get(sessionId);
    if (!p) return;
    p.then((entry) => {
      const m = entry.machine as unknown as {
        interrupt?: () => void;
        abortInFlight?: () => void;
      };
      if (typeof m.interrupt === "function") m.interrupt();
      else if (typeof m.abortInFlight === "function") m.abortInFlight();
      // If the machine doesn't expose either method, the user.interrupt
      // event is appended to the log by the route handler (P3 wires the
      // actual abort plumbing into SessionStateMachine).
    }).catch(() => {
      /* getOrCreate failed — nothing to abort */
    });
  }

  /**
   * True once this process has built (or is building) the machine for a
   * session. The binding routes use this to reject post-build memory
   * binds with 409: mounts are provisioned exactly once in build() and
   * the machine's reminders snapshot is frozen to that mount list, so a
   * late binding could never take effect and must not be accepted.
   */
  isBuilt(sessionId: string): boolean {
    return this.map.has(sessionId);
  }

  /** Phase 0 Node delegation: one child level, isolated thread history. */
  private async runSubAgent(opts: {
    sessionId: string;
    tenantId: string;
    agentId: string;
    version?: number;
    message: string;
    parentThreadId: string;
  }): Promise<string> {
    const entry = await this.getOrCreate(opts.sessionId, opts.tenantId);
    const current = await this.deps.agentsService.get({
      tenantId: opts.tenantId,
      agentId: opts.agentId,
    });
    if (!current) throw new Error(`agent ${opts.agentId} not found`);

    let resolved: AgentConfig;
    if (opts.version === undefined || opts.version === current.version) {
      const { tenant_id: _tenantId, ...snapshot } = current;
      resolved = snapshot;
    } else if (opts.version < current.version) {
      const historical = await this.deps.agentsService.getVersion({
        tenantId: opts.tenantId,
        agentId: opts.agentId,
        version: opts.version,
      });
      if (!historical) throw new Error(`agent version ${opts.version} not found`);
      resolved = historical.snapshot;
    } else {
      throw new Error(`agent version ${opts.version} not found`);
    }

    const frozen = await hashJsonSnapshot(resolved);
    const threadId = `sthr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const createdAt = Date.now();
    await this.deps.sql
      .prepare(
        `INSERT INTO session_threads
          (session_id, id, agent_id, agent_name, agent_version, agent_snapshot,
           config_hash, hash_algorithm, parent_thread_id, input_tokens,
           output_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      )
      .bind(
        opts.sessionId,
        threadId,
        opts.agentId,
        frozen.normalized.name,
        frozen.normalized.version,
        JSON.stringify(frozen.normalized),
        frozen.configHash,
        frozen.hashAlgorithm,
        opts.parentThreadId,
        createdAt,
      )
      .run();

    const threadCreated = {
      type: "session.thread_created",
      session_thread_id: threadId,
      agent_id: opts.agentId,
      agent_name: frozen.normalized.name,
      agent_version: frozen.normalized.version,
      config_hash: frozen.configHash,
      parent_thread_id: opts.parentThreadId,
    } as unknown as SessionEvent;
    await entry.eventLog.appendAsync(threadCreated);
    this.deps.hub.publish(opts.sessionId, threadCreated);

    const userMessage = {
      type: "user.message",
      session_thread_id: threadId,
      content: [{ type: "text", text: opts.message }],
    } as unknown as UserMessageEvent;
    await entry.eventLog.appendAsync(userMessage);
    this.deps.hub.publish(opts.sessionId, userMessage);

    // Phase 0 is deliberately one level on Node. Preserve the frozen roster
    // in storage, but do not expose nested call_agent_* tools to this run.
    const executionAgent = { ...frozen.normalized, callable_agents: [] };
    const tools = await this.deps.buildTools(
      executionAgent,
      entry.sandbox,
      opts.tenantId,
      opts.sessionId,
    );
    const model = await this.deps.buildModel(executionAgent, opts.tenantId);
    const context = await this.deps.buildHarnessContext({
      agent: executionAgent,
      userMessage,
      sandbox: entry.sandbox,
      tools,
      model,
      sessionId: opts.sessionId,
      tenantId: opts.tenantId,
      eventLog: entry.eventLog,
      memoryReminders: [],
      sessionThreadId: threadId,
    });
    await this.deps.buildHarness().run(context);
    const runtime = (context as { runtime?: { flush?: () => Promise<void> } }).runtime;
    await runtime?.flush?.();

    const events = await entry.eventLog.getEventsAsync();
    const reply = [...events].reverse().find(
      (event) =>
        event.type === "agent.message" &&
        (event as { session_thread_id?: string }).session_thread_id === threadId,
    ) as { content?: unknown } | undefined;
    return reply?.content ? extractTextFromContent(reply.content as never) : "";
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private async build(
    sessionId: string,
    tenantId: string,
  ): Promise<SessionEntry> {
    // ── DB-level freeze: the multi-replica half of the bind gate ──
    // Persist memory_frozen_at BEFORE reading the binding list below.
    // From this commit onward, bindMemoryStore's conditional INSERT is
    // rejected by the database on ANY replica — including one whose
    // in-process map is empty — so a late bind can never land a row
    // that this build won't mount. The in-process session lock covers
    // the same race within this replica.
    const frozenAt = Date.now();
    await this.deps.sql
      .prepare(
        `UPDATE sessions SET memory_frozen_at = ? WHERE id = ? AND memory_frozen_at IS NULL`,
      )
      .bind(frozenAt, sessionId)
      .run();
    try {
      return await this.buildInner(sessionId, tenantId);
    } catch (err) {
      // Build failed before anything was mounted — the session is not
      // actually frozen. Clear the flag so a retry build can accept new
      // binds again. Conditioned on OUR value so this never clobbers a
      // successor freeze (getOrCreate's identity-safe map cleanup makes
      // the session re-buildable in this replica too).
      //
      // Known bounded race: another replica may have piggybacked on
      // this freeze and built a live machine in the meantime; clearing
      // then would let a late bind be accepted but never mounted. Needs
      // build failure AND a concurrent cross-replica build in the same
      // window — accepted for Phase 0.
      await this.deps.sql
        .prepare(
          `UPDATE sessions SET memory_frozen_at = NULL WHERE id = ? AND memory_frozen_at = ?`,
        )
        .bind(sessionId, frozenAt)
        .run()
        .catch(() => undefined);
      throw err;
    }
  }

  private async buildInner(
    sessionId: string,
    tenantId: string,
  ): Promise<SessionEntry> {
    const sessionRow = await this.deps.sql
      .prepare(
        `SELECT agent_id, agent_snapshot, snapshot_state, snapshot_hash
           FROM sessions WHERE id = ? AND tenant_id = ?`,
      )
      .bind(sessionId, tenantId)
      .first<{
        agent_id: string | null;
        agent_snapshot: string | null;
        snapshot_state: string | null;
        snapshot_hash: string | null;
      }>();
    if (!sessionRow) throw new Error(`session ${sessionId} not found in tenant`);
    // Rolling-upgrade bridge for rows created before the lifecycle columns.
    // The conditional UPDATE makes this safe across replicas; non-null legacy
    // snapshots become finalized directly and never pass through building.
    if (sessionRow.snapshot_state === null) {
      if (sessionRow.agent_snapshot) {
        const legacySnapshot = JSON.parse(sessionRow.agent_snapshot) as AgentConfig;
        const hashed = await hashJsonSnapshot(legacySnapshot);
        const migratedAt = Date.now();
        await this.deps.sql
          .prepare(
            `UPDATE sessions
                SET agent_snapshot = ?, snapshot_state = 'finalized',
                    snapshot_hash = ?, snapshot_finalized_at = ?
              WHERE id = ? AND tenant_id = ? AND snapshot_state IS NULL`,
          )
          .bind(
            JSON.stringify(hashed.normalized),
            hashed.configHash,
            migratedAt,
            sessionId,
            tenantId,
          )
          .run();
        sessionRow.agent_snapshot = JSON.stringify(hashed.normalized);
        sessionRow.snapshot_state = "finalized";
        sessionRow.snapshot_hash = hashed.configHash;
      } else {
        await this.deps.sql
          .prepare(
            `UPDATE sessions SET snapshot_state = 'legacy_unversioned'
              WHERE id = ? AND tenant_id = ? AND snapshot_state IS NULL`,
          )
          .bind(sessionId, tenantId)
          .run();
        sessionRow.snapshot_state = "legacy_unversioned";
      }
    }
    const frozenPrimaryAgent =
      sessionRow.snapshot_state === "finalized" && sessionRow.agent_snapshot
        ? (JSON.parse(sessionRow.agent_snapshot) as AgentConfig)
        : null;
    if (frozenPrimaryAgent) {
      await this.deps.sql
        .prepare(
          `INSERT INTO session_threads
            (session_id, id, agent_id, agent_name, agent_version, agent_snapshot,
             config_hash, hash_algorithm, parent_thread_id, input_tokens,
             output_tokens, created_at)
           VALUES (?, 'sthr_primary', ?, ?, ?, ?, ?, 'sha256:jcs-rfc8785:v1',
                   NULL, 0, 0, ?)
           ON CONFLICT (session_id, id) DO NOTHING`,
        )
        .bind(
          sessionId,
          sessionRow.agent_id,
          frozenPrimaryAgent.name,
          frozenPrimaryAgent.version,
          sessionRow.agent_snapshot,
          sessionRow.snapshot_hash,
          Date.now(),
        )
        .run();
    }

    const sandboxWorkdir = join(this.deps.sandboxWorkdirRoot, sessionId);
    const sandbox = await this.deps.buildSandbox(sessionId, sandboxWorkdir);

    // Resolve the per-session memory bindings + outputs flag, then hand
    // the whole bundle to the orchestrator. The orchestrator owns
    // ordering (vault outbound first, restore second, mounts last) so
    // the registry no longer reasons about it.
    const memoryBindings = await this.deps.sql
      .prepare(`SELECT store_id, access FROM session_memory_stores WHERE session_id = ?`)
      .bind(sessionId)
      .all<{ store_id: string; access: string }>();
    const memoryMounts: OrchestratorMemoryMount[] = [];
    const resolvedMounts: Array<{
      storeId: string;
      storeName: string;
      description?: string | null;
      readOnly: boolean;
    }> = [];
    for (const binding of memoryBindings.results ?? []) {
      const store = await this.deps.memoryService.getStore({ tenantId, storeId: binding.store_id });
      if (!store) continue;
      memoryMounts.push({
        storeName: store.name,
        storeId: binding.store_id,
        readOnly: binding.access === "read_only",
      });
      resolvedMounts.push({
        storeId: binding.store_id,
        storeName: store.name,
        description: store.description,
        readOnly: binding.access === "read_only",
      });
    }
    // Freeze the reminders snapshot to the exact mount list above. It is
    // captured in the machine's buildHarnessContext closure below, so
    // every turn of this (cached) machine sees the same reminders — the
    // prompt can never drift from the provisioned mounts. Late bindings
    // are rejected with 409 by the binding routes (see isBuilt).
    const memoryReminders = remindersFromMounts(resolvedMounts);
    await this.deps.sandboxOrchestrator.provision(sandbox, {
      sessionId,
      tenantId,
      memoryMounts,
      mountOutputs: true,
      backup: { restoreOnWarm: true },
    });

    const eventLog = this.deps.newEventLog(sessionId);
    const streams = new SqlStreamRepo(this.deps.sql, sessionId, this.deps.sqlDialect ?? "sqlite");

    const adapter = new RuntimeAdapterImpl({
      sql: this.deps.sql,
      eventLog,
      streams,
      sandbox,
      // Node has no eviction — leave hintTurnInFlight unset.
    });

    const machine = new SessionStateMachine({
      sessionId,
      tenantId,
      adapter,
      sandbox,
      loadAgent: async (agentId) => {
        if (agentId === sessionRow.agent_id) {
          if (!frozenPrimaryAgent) {
            throw new Error(`session ${sessionId} snapshot is not finalized`);
          }
          return frozenPrimaryAgent;
        }
        const row = await this.deps.agentsService.get({ tenantId, agentId });
        return row ?? null;
      },
      // Memory + outputs mounting happens in the orchestrator above.
      // SessionStateMachine still accepts the hooks for CF parity but
      // Node passes no-ops since the work has already been done.
      mountMemoryStores: async () => {},
      mountSessionOutputs: async () => {},
      buildModel: (agent) => this.deps.buildModel(agent, tenantId),
      buildTools: (agent, sb) =>
        this.deps.buildTools(
          agent,
          sb,
          tenantId,
          sessionId,
          (agentId, message, version) =>
            this.runSubAgent({
              sessionId,
              tenantId,
              agentId,
              version,
              message,
              parentThreadId: "sthr_primary",
            }),
        ),
      buildHarness: () => this.deps.buildHarness(),
      buildHarnessContext: (input) =>
        this.deps.buildHarnessContext({
          ...input,
          sessionId,
          tenantId,
          eventLog,
          memoryReminders,
        }),
      publish: (event: SessionEvent) => this.deps.hub.publish(sessionId, event),
    });

    return { machine, sandbox, eventLog };
  }
}
