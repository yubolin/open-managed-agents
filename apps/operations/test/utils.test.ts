import { describe, expect, it } from "vitest";
import { getStateMeta, shortHash, formatDate } from "../src/lib/utils";
import type { WorkspaceRunState } from "@open-managed-agents/api-types";

describe("Base D · Operations Frontend Utilities", () => {
  const ALL_13_STATES: WorkspaceRunState[] = [
    "draft",
    "submitted",
    "planning",
    "awaiting_approval",
    "changes_requested",
    "approval_invalidated",
    "approved",
    "rejected",
    "executing",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ];

  it("1. 13-State Coverage: Every state in the state machine has valid meta mapping", () => {
    for (const state of ALL_13_STATES) {
      const meta = getStateMeta(state);
      expect(meta.label).toBeDefined();
      expect(meta.badgeClass).toBeDefined();
      expect(meta.dotClass).toBeDefined();
      expect(["pending", "progress", "approval", "success", "failure"]).toContain(meta.category);
    }
  });

  it("2. shortHash: Correctly shortens SHA256 hashes with ellipsis", () => {
    const fullHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const shortened = shortHash(fullHash, 10);
    expect(shortened).toBe("e3b0c44298...");
    expect(shortHash(null)).toBe("—");
  });

  it("3. formatDate: Formats epoch timestamps cleanly", () => {
    const formatted = formatDate(1700000000000);
    expect(formatted).not.toBe("—");
    expect(formatDate(null)).toBe("—");
  });
});
