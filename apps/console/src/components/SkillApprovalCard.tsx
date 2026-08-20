/**
 * Pending skill-tool approval card (agent self-install SDS §2.2, slice F5).
 *
 * Mutating skill tools (install_skill / attach_skill / detach_skill /
 * uninstall_skill) default to always_ask: the model's tool call goes
 * PENDING — an agent.tool_use with no matching agent.tool_result. This
 * card surfaces those calls and is the ONLY place a human approval is
 * minted into a confirmation_token:
 *
 *   Approve → POST /v1/skills/confirmation {purpose}   (mint, 60s TTL)
 *           → POST /v1/sessions/:id/events
 *               user.tool_confirmation {result:"allow", confirmation_token}
 *   Deny    → POST user.tool_confirmation {result:"deny"} (no token)
 *
 * SessionDO re-executes the approved call with the token threaded into
 * the tool's execute; SkillRpc consumes it exactly once platform-side.
 * Without this card's mint step the re-executed call 403s — the token is
 * the server-verifiable proof a human clicked Approve.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { Event } from "../lib/events";

/** Mutating skill tools — must mirror DEFAULT_ASK_TOOLS in
 *  apps/agent/src/harness/tools.ts. */
const CONFIRMABLE_TOOLS = new Set([
  "install_skill",
  "attach_skill",
  "detach_skill",
  "uninstall_skill",
]);

/** attach_skill mints purpose "attach"; every other confirmable tool is an
 *  install-lane action platform-side (SDS §2.2 purpose binding). */
function purposeFor(toolName: string): "install" | "attach" {
  return toolName === "attach_skill" ? "attach" : "install";
}

interface PendingCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** agent.tool_use on a confirmable tool with no agent.tool_result yet. */
export function pendingSkillCalls(events: Event[]): PendingCall[] {
  const resolved = new Set(
    events
      .filter((e) => e.type === "agent.tool_result" && e.tool_use_id)
      .map((e) => String(e.tool_use_id)),
  );
  return events
    .filter(
      (e) =>
        e.type === "agent.tool_use" &&
        typeof e.name === "string" &&
        CONFIRMABLE_TOOLS.has(e.name) &&
        e.id &&
        !resolved.has(String(e.id)),
    )
    .map((e) => ({ id: String(e.id), name: e.name!, input: e.input ?? {} }));
}

function argSummary(call: PendingCall): string {
  const { slug, skill_id, agent_id, version } = call.input as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof slug === "string") parts.push(slug);
  if (typeof skill_id === "string") parts.push(skill_id);
  if (typeof agent_id === "string") parts.push(`→ ${agent_id}`);
  if (typeof version === "string") parts.push(`@${version}`);
  return parts.join(" ");
}

export function SkillApprovalCard(props: {
  sessionId: string;
  events: Event[];
  api: (path: string, init?: RequestInit) => Promise<unknown>;
}) {
  const pending = useMemo(() => pendingSkillCalls(props.events), [props.events]);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (pending.length === 0) return null;

  const respond = async (call: PendingCall, result: "allow" | "deny") => {
    setBusyId(call.id);
    try {
      let confirmation_token: string | undefined;
      if (result === "allow") {
        // Mint FIRST — the token lives 60s and dies after one use, so it
        // must be minted in the same breath as the approval POST.
        const mint = (await props.api("/v1/skills/confirmation", {
          method: "POST",
          body: JSON.stringify({ purpose: purposeFor(call.name) }),
        })) as { confirmation_token?: string };
        if (!mint?.confirmation_token) {
          toast.error("Confirmation mint failed — approval not sent.");
          return;
        }
        confirmation_token = mint.confirmation_token;
      }
      await props.api(`/v1/sessions/${props.sessionId}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [
            {
              type: "user.tool_confirmation",
              tool_use_id: call.id,
              result,
              ...(confirmation_token ? { confirmation_token } : {}),
            },
          ],
        }),
      });
      // The tool_result event (or deny handling) comes back over SSE and
      // clears this card via the pending recomputation.
    } catch {
      // api() already toasted the failure detail.
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="px-3 pb-2 bg-bg shrink-0" data-testid="skill-approval-card">
      {pending.map((call) => (
        <div
          key={call.id}
          className="border border-warning/40 rounded-lg bg-warning/5 px-3 py-2.5 mb-2 flex items-center gap-3 flex-wrap"
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-fg">
              Agent wants to run <span className="font-mono">{call.name}</span>
            </div>
            {argSummary(call) && (
              <div className="text-xs text-fg-muted font-mono truncate mt-0.5">
                {argSummary(call)}
              </div>
            )}
            <div className="text-[11px] text-fg-subtle mt-0.5">
              Your approval mints a one-time, 60s confirmation token.
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              disabled={busyId === call.id}
              onClick={() => respond(call, "deny")}
            >
              Deny
            </Button>
            <Button
              size="sm"
              disabled={busyId === call.id}
              onClick={() => respond(call, "allow")}
            >
              Approve
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
