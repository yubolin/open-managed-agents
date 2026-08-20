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

export async function mintSkillConfirmation(args: {
  kv: ConfirmationKv;
  tenantId: string;
  purpose: ConfirmationPurpose;
  /** DI seam for tests — defaults to the platform crypto. */
  randomId?: () => string;
}): Promise<{ token: string; expires_in: number }> {
  const token = args.randomId ? args.randomId() : randomTokenHex();
  await args.kv.put(kvKey(args.tenantId, "skillconf", token), JSON.stringify({ purpose: args.purpose }), {
    expirationTtl: CONFIRMATION_TTL_SECONDS,
  });
  return { token, expires_in: CONFIRMATION_TTL_SECONDS };
}

export async function consumeSkillConfirmation(args: {
  kv: ConfirmationKv;
  tenantId: string;
  token: string | undefined;
  purpose: ConfirmationPurpose;
}): Promise<void> {
  if (!args.token) throw new ConfirmationRequiredError();
  const key = kvKey(args.tenantId, "skillconf", args.token);
  const raw = await args.kv.get(key);
  // Covers never-minted, already-used (deleted), expired, cross-tenant,
  // and cross-purpose uniformly — the SDS deliberately does not
  // distinguish these to the caller (403 either way, no oracle).
  if (!raw) throw new ConfirmationRequiredError();
  const parsed = JSON.parse(raw) as { purpose?: string };
  if (parsed.purpose !== args.purpose) throw new ConfirmationRequiredError();
  await args.kv.delete(key); // single-use
}

/** Entry point for SkillRpc: admin-allowlist bypass first, then the
 *  one-time/TTL/purpose check. Throws ConfirmationRequiredError → 403. */
export async function skillConfirmationGuard(args: {
  kv: ConfirmationKv;
  tenantId: string;
  token: string | undefined;
  purpose: ConfirmationPurpose;
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
