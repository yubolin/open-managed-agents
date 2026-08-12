// Memory store platform reminders — Node mirror of CF session-do.ts:4419-4461.
//
// Task 2 (§3.8) + P1 review: reminders must never drift from the mounts
// the sandbox actually got. SessionRegistry provisions mounts ONCE in
// build() and caches the machine forever, so:
//
//   1. remindersFromMounts is a pure transform of the RESOLVED mount
//      list build() provisions (format parity covered below), and the
//      registry freezes that snapshot into the machine's
//      buildHarnessContext closure — no per-turn re-read of
//      session_memory_stores.
//   2. The binding route rejects post-build binds with 409 (lifecycle
//      E2E below): a store bound after the first run, or an access-mode
//      change after the first run, cannot persist — therefore it can
//      never surface as a fake reminder on a later turn.
//
// Format parity with CF:
//   ## Memory store: <name>
//   Mounted at /mnt/memory/<name>/ (read-write | read-only)
//   [description]
//   (read-only mount — write attempts to this directory will fail)   ← read_only only
// Source tag: `memory:<store_id>`.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { remindersFromMounts } from "../src/lib/memory-reminders.js";

describe("remindersFromMounts (format parity with CF)", () => {
  it("read-write mount → descriptor without the read-only warning", () => {
    const reminders = remindersFromMounts([
      {
        storeId: "ms_1",
        storeName: "project-knowledge",
        description: "Learnings about the codebase",
        readOnly: false,
      },
    ]);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.source).toBe("memory:ms_1");
    expect(reminders[0]!.text).toContain("## Memory store: project-knowledge");
    expect(reminders[0]!.text).toContain(
      "Mounted at /mnt/memory/project-knowledge/ (read-write)",
    );
    expect(reminders[0]!.text).toContain("Learnings about the codebase");
    expect(reminders[0]!.text).not.toContain("read-only mount");
  });

  it("read-only mount → read-only label + explicit write warning", () => {
    const reminders = remindersFromMounts([
      { storeId: "ms_2", storeName: "group-shared", description: null, readOnly: true },
    ]);
    expect(reminders[0]!.text).toContain("Mounted at /mnt/memory/group-shared/ (read-only)");
    expect(reminders[0]!.text).toContain(
      "(read-only mount — write attempts to this directory will fail)",
    );
  });

  it("no mounts → no reminders (no memory section in system prompt)", () => {
    expect(remindersFromMounts([])).toEqual([]);
  });

  it("mount order is preserved with per-store sources", () => {
    const reminders = remindersFromMounts([
      { storeId: "ms_a", storeName: "store-a", readOnly: false },
      { storeId: "ms_b", storeName: "store-b", readOnly: true },
    ]);
    expect(reminders.map((r) => r.source)).toEqual(["memory:ms_a", "memory:ms_b"]);
    expect(reminders[0]!.text).toContain("(read-write)");
    expect(reminders[1]!.text).toContain("(read-only)");
  });
});

// ── Lifecycle E2E ──────────────────────────────────────────────────────
// The drift scenario from the P1 review: mounts happen once in
// SessionRegistry.build(); bindings added (or access modes changed)
// afterwards would otherwise let a later turn's prompt claim mounts the
// sandbox doesn't have. The binding route must reject them with 409.

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx");

interface ProcessHandle {
  child: ChildProcess;
  port: number;
  dataDir: string;
  logBuf: string[];
}

describe("memory binding lifecycle (frozen after first run)", () => {
  let h: ProcessHandle | null = null;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = join(tmpdir(), `oma-test-reminders-${randomBytes(6).toString("hex")}`);
    mkdirSync(dataDir, { recursive: true });
    h = await startMainNode({ dataDir });
  }, 60_000);

  afterAll(async () => {
    if (h) {
      await killHard(h).catch(() => {});
      h = null;
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("post-build bind / access change → 409 and never surfaces as a reminder", async () => {
    const base = `http://localhost:${h!.port}/v1`;

    const storeEarly = await createMemoryStore(base, "early-notes");
    const storeLate = await createMemoryStore(base, "late-notes");

    const agentId = await createAgent(base);
    const sessionId = await createSession(base, agentId);

    // Pre-run binding is accepted.
    const preBind = await bind(base, sessionId, storeEarly, "read_write");
    expect(preBind.status).toBe(201);

    // First run: triggers SessionRegistry.build() (mounts + frozen
    // reminders snapshot). The turn itself fails without an LLM key —
    // irrelevant here; the machine is built regardless.
    await postUserMessage(base, sessionId, "hello");
    await waitForMachineBuilt(base, sessionId);

    // A NEW binding after build must be rejected…
    const lateBind = await bind(base, sessionId, storeLate, "read_write");
    expect(lateBind.status).toBe(409);

    // …and so must an access-mode change on the existing binding
    // (read_write → read_only would otherwise claim OS-level read-only
    // while the live mount stays writable).
    const accessChange = await bind(base, sessionId, storeEarly, "read_only");
    expect(accessChange.status).toBe(409);

    // Nothing persisted: the late store has no row, and the early store
    // keeps its original access. The machine's frozen reminders
    // snapshot (taken at build time from this exact row set) therefore
    // stays truthful on every later turn — no fake reminder is possible.
    const listRes = await fetch(`${base}/sessions/${sessionId}/memory_stores`);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      data: Array<{ store_id: string; access: string }>;
    };
    expect(listed.data.map(({ store_id, access }) => ({ store_id, access }))).toEqual([
      { store_id: storeEarly, access: "read_write" },
    ]);
  }, 90_000);

  it("GET is tenant-scoped: another tenant's session id → 404", async () => {
    const base = `http://localhost:${h!.port}/v1`;

    // Seed a session + binding that belong to a DIFFERENT tenant,
    // straight into the server's SQLite file (the route under
    // AUTH_DISABLED always acts as the default tenant).
    const foreignSid = `sess-foreign-${randomBytes(4).toString("hex")}`;
    const db = new BetterSqlite3(join(dataDir, "oma.db"));
    try {
      db.prepare(
        `INSERT INTO sessions (id, tenant_id, status, title, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(foreignSid, "tenant-other", "idle", "", Date.now());
      db.prepare(
        `INSERT INTO session_memory_stores (session_id, store_id, access, created_at) VALUES (?, ?, ?, ?)`,
      ).run(foreignSid, "ms_foreign_secret", "read_write", Date.now());
    } finally {
      db.close();
    }

    // Default tenant queries the foreign session id — must be a uniform
    // 404 (not a leak of the binding list).
    const res = await fetch(`${base}/sessions/${foreignSid}/memory_stores`);
    expect(res.status).toBe(404);
  }, 30_000);
});

// ── E2E helpers ────────────────────────────────────────────────────────

async function startMainNode(opts: { dataDir: string }): Promise<ProcessHandle> {
  const port = await pickPort();
  const child = spawn(TSX_BIN, [MAIN_NODE_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(opts.dataDir, "oma.db"),
      AUTH_DATABASE_PATH: join(opts.dataDir, "auth.db"),
      SANDBOX_WORKDIR: join(opts.dataDir, "sandboxes"),
      MEMORY_BLOB_DIR: join(opts.dataDir, "memory-blobs"),
      FILES_BLOB_DIR: join(opts.dataDir, "files-blobs"),
      SESSION_OUTPUTS_DIR: join(opts.dataDir, "outputs"),
      AUTH_DISABLED: "1",
      BETTER_AUTH_SECRET: "test-secret-only-for-vitest",
      // No ANTHROPIC_API_KEY on purpose: the first turn fails, but the
      // machine (mounts + reminders snapshot) is built before that.
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logBuf: string[] = [];
  child.stdout?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  child.stderr?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        await sleep(300);
        return { child, port, dataDir: opts.dataDir, logBuf };
      }
    } catch {
      /* not ready */
    }
    await sleep(200);
  }
  console.error("main-node never became ready. Logs:\n" + logBuf.join(""));
  child.kill("SIGKILL");
  throw new Error(`main-node didn't respond on /health within 30s`);
}

async function createMemoryStore(base: string, name: string): Promise<string> {
  const res = await fetch(`${base}/memory_stores`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function createAgent(base: string): Promise<string> {
  const res = await fetch(`${base}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "reminder-lifecycle-agent",
      model: "claude-sonnet-4-6",
      system: "You are a test agent.",
      tools: [],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function createSession(base: string, agentId: string): Promise<string> {
  const res = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: agentId,
      // No runtime_binding on the agent → route demands an environment;
      // main-node serves a synthetic snapshot for this id.
      environment_id: "env-local-runtime",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

function bind(
  base: string,
  sessionId: string,
  storeId: string,
  access: "read_write" | "read_only",
): Promise<Response> {
  return fetch(`${base}/sessions/${sessionId}/memory_stores`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ store_id: storeId, access }),
  });
}

async function postUserMessage(base: string, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`${base}/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text }],
        },
      ],
    }),
  });
  // 200/202 both fine — the point is enqueueUserMessage ran, which
  // builds the machine (and its frozen reminders snapshot) synchronously.
  if (res.status >= 500) {
    throw new Error(`user.message failed: ${res.status} ${await res.text()}`);
  }
}

/** Poll until SessionRegistry.isBuilt(sid) is observable via the 409
 *  gate — any bind attempt returns 409 exactly when the machine exists.
 *  (Pre-build it returns 2xx/4xx for other reasons, never 409.) */
async function waitForMachineBuilt(base: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/sessions/${sessionId}/memory_stores`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ store_id: "ms_probe_does_not_exist" }),
    });
    if (res.status === 409) return; // machine built → gate active
    await sleep(200);
  }
  throw new Error("session machine was never built within 15s");
}

function pickPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
    srv.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function killHard(h: ProcessHandle): Promise<void> {
  if (h.child.exitCode !== null) return;
  h.child.kill("SIGKILL");
  await sleep(200);
}
