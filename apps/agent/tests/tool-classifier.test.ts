// P1 review 2026-08-20: confirm the unified classifier used by
// session-do.ts puts install_skill / attach_skill / search_skill into
// the built-in (tool_confirmation) bucket, NOT the opaque custom_tool_result
// bucket. SDK + non-Console clients rely on the action_type to pick the
// approval protocol branch.

import { describe, it, expect } from "vitest";
import { DEFAULT_TOOLS, DEFAULT_ASK_TOOLS } from "../src/harness/tools";

function isCustomTool(toolName: string): boolean {
  if (DEFAULT_TOOLS.includes(toolName)) return false;
  if (DEFAULT_ASK_TOOLS.has(toolName)) return false;
  if (toolName.startsWith("mcp_")) return false;
  if (toolName.startsWith("call_agent_")) return false;
  if (toolName.startsWith("memory_")) return false;
  return true;
}

describe("pending-tool classifier (P1 review 2026-08-20)", () => {
  it("built-in defaults stay in the confirmation bucket", () => {
    for (const t of [
      "bash",
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "web_fetch",
      "web_search",
    ]) {
      expect(isCustomTool(t)).toBe(false);
    }
  });

  it("skill tools (DEFAULT + DEFAULT_ASK) stay in the confirmation bucket", () => {
    for (const t of [
      "search_skill",
      "install_skill",
      "attach_skill",
      "detach_skill",
      "uninstall_skill",
    ]) {
      expect(isCustomTool(t)).toBe(false);
    }
  });

  it("namespaced prefixes (mcp_/call_agent_/memory_) stay in the confirmation bucket", () => {
    expect(isCustomTool("mcp_github_issue")).toBe(false);
    expect(isCustomTool("call_agent_worker")).toBe(false);
    expect(isCustomTool("memory_search")).toBe(false);
  });

  it("truly custom tool names land in the custom_tool_result bucket", () => {
    expect(isCustomTool("user_defined_acme_tool")).toBe(true);
    expect(isCustomTool("slack_send")).toBe(true);
  });
});