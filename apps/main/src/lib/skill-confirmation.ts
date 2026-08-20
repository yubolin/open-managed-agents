// confirmation_token (SDS agent-self-install §2.2, slice F5).
//
// Server-verifiable human approval for the mutating skill tools:
//   1. Console renders the pending install_skill / attach_skill call and,
//      on Approve, mints a token via POST /v1/skills/confirmation (an
//      authenticated user action — that auth IS the "human confirmed"
//      attestation).
//   2. The approval travels to the session as
//      user.tool_confirmation { confirmation_token }, and the tool's
//      execute passes it to SkillRpc.
//   3. SkillRpc consumes it here: single-use (delete-on-read), TTL 60s,
//      purpose-bound, tenant-scoped. Any failure is uniformly 403
//      "confirmation required or expired".
//
// Admin bypass: OMA_SKILL_ADMIN_ALLOWLIST (comma-separated tenant ids of
// operational accounts) skips the token requirement entirely.
//
// Known limitation (documented, accepted): KV get-then-delete is not
// atomic, so two CONCURRENT submits of the same token can both pass.
// CF KV offers no check-and-delete; the token is short-lived and minted
// per-approval, so the replay window is negligible.

import { kvKey } from "../kv-helpers";

/** SDS §2.2: TTL 60 seconds. */
export const CONFIRMATION_TTL_SECONDS = 60;

export type ConfirmationPurpose = "install" | "attach";

/** The shape of the call the token authorizes (P1 review 2026-08-20).
 *  Storing a canonical hash of this object at mint time and re-hashing
 *  on consume gives the server proof that the user approved THIS
 *  specific call — not just "some install / some attach". */
export interface ConfirmationBinding {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  /** Caller-normalized tool input. Object key order MUST NOT affect
   *  the hash (canonical JSON serialization handles this). */
  canonicalInput: unknown;
}

export class ConfirmationRequiredError extends Error {
  constructor(message = "confirmation required or expired") {
    super(message);
  }
}

/** Structural KvStore deps (tests inject fakes; prod passes services.kv). */
interface ConfirmationKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 32 random bytes → 64-char hex. Unguessable single-use token. */
function randomTokenHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable JSON serialization with sorted keys at every depth. The hash
 *  is order-insensitive so the caller doesn't have to remember which
 *  order to put `{slug, version}` in. */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJsonStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

async function bindingHash(binding: ConfirmationBinding): Promise<string> {
  const enc = new TextEncoder().encode(canonicalJsonStringify(binding));
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mintSkillConfirmation(args: {
  kv: ConfirmationKv;
  tenantId: string;
  purpose: ConfirmationPurpose;
  /** P1 review 2026-08-20: bind the token to the exact call shape so
   *  approve-and-replay-of-different-args is rejected at consume. */
  binding?: ConfirmationBinding;
  /** DI seam for tests — defaults to the platform crypto. */
  randomId?: () => string;
}): Promise<{ token: string; expires_in: number }> {
  const token = args.randomId ? args.randomId() : randomTokenHex();
  const payload: Record<string, unknown> = { purpose: args.purpose };
  if (args.binding) {
    payload.session_id = args.binding.sessionId;
    payload.tool_use_id = args.binding.toolUseId;
    payload.tool_name = args.binding.toolName;
    payload.canonical_input_hash = await bindingHash(args.binding);
  }
  await args.kv.put(
    kvKey(args.tenantId, "skillconf", token),
    JSON.stringify(payload),
    { expirationTtl: CONFIRMATION_TTL_SECONDS },
  );
  return { token, expires_in: CONFIRMATION_TTL_SECONDS };
}

export async function consumeSkillConfirmation(args: {
  kv: ConfirmationKv;
  tenantId: string;
  token: string | undefined;
  purpose: ConfirmationPurpose;
  /** Required when the token was minted with a binding. Omitting it
   *  on a binding-bound token MUST fail closed. */
  binding?: ConfirmationBinding;
}): Promise<void> {
  if (!args.token) throw new ConfirmationRequiredError();
  const key = kvKey(args.tenantId, "skillconf", args.token);
  const raw = await args.kv.get(key);
  // Covers never-minted, already-used (deleted), expired, cross-tenant,
  // and cross-purpose uniformly — the SDS deliberately does not
  // distinguish these to the caller (403 either way, no oracle).
  if (!raw) throw new ConfirmationRequiredError();
  const parsed = JSON.parse(raw) as {
    purpose?: string;
    session_id?: string;
    tool_use_id?: string;
    tool_name?: string;
    canonical_input_hash?: string;
  };
  if (parsed.purpose !== args.purpose) throw new ConfirmationRequiredError();
  // Binding check (fail closed). If the token was minted with a binding,
  // the consumer MUST pass one too, AND every field must match.
  if (parsed.canonical_input_hash) {
    if (!args.binding) throw new ConfirmationRequiredError();
    if (parsed.session_id !== args.binding.sessionId) throw new ConfirmationRequiredError();
    if (parsed.tool_use_id !== args.binding.toolUseId) throw new ConfirmationRequiredError();
    if (parsed.tool_name !== args.binding.toolName) throw new ConfirmationRequiredError();
    const provided = await bindingHash(args.binding);
    if (provided !== parsed.canonical_input_hash) throw new ConfirmationRequiredError();
  } else if (args.binding) {
    // Token minted without binding but consumer passed one — fail closed.
    throw new ConfirmationRequiredError();
  }
  await args.kv.delete(key); // single-use
}

/** Entry point for SkillRpc: admin-allowlist bypass first, then the
 *  one-time/TTL/purpose check. Throws ConfirmationRequiredError → 403. */
export async function skillConfirmationGuard(args: {
  kv: ConfirmationKv;
  tenantId: string;
  token: string | undefined;
  purpose: ConfirmationPurpose;
  binding?: ConfirmationBinding;
  /** Raw OMA_SKILL_ADMIN_ALLOWLIST env value (comma-separated tenant ids). */
  adminAllowlist?: string;
}): Promise<void> {
  const allow = (args.adminAllowlist || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes(args.tenantId)) return; // ops tenant — no token needed
  await consumeSkillConfirmation(args);
}
