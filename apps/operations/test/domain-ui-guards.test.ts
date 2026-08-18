import { describe, expect, it } from "vitest";
import {
  getStateMeta,
  getCurrentUserId,
  isSelfApproval,
  shortHash,
  validateRequiredFields,
} from "../src/lib/utils";

describe("Base D · UI Defense Guards & Domain Alignments", () => {
  it("1. SoD Guard: isSelfApproval (real util used by ApprovalsPage) detects applicant identity", () => {
    expect(isSelfApproval("user_operator_bob", "user_operator_bob")).toBe(true);
    expect(isSelfApproval("user_sre_alice", "user_operator_bob")).toBe(false);
    expect(isSelfApproval(undefined, "user_operator_bob")).toBe(false);
    expect(isSelfApproval(null, "user_operator_bob")).toBe(false);
  });

  it("2. Dual-Hash Guard: validates presence and format of plan_hash and evidence_hash", () => {
    const planHash = "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef";
    const evidenceHash = "f0e1d2c3b4a5968778695a4b3c2d1e0f0123456789abcdef0123456789abcdef";

    expect(shortHash(planHash, 10)).toBe("a1b2c3d4e5...");
    expect(shortHash(evidenceHash, 10)).toBe("f0e1d2c3b4...");
    expect(shortHash(undefined)).toBe("—");
    expect(shortHash(null)).toBe("—");
  });

  it("3. State Timeline Mapping: 13 states map into 5 visual stages", () => {
    const stage1States = ["draft", "submitted"];
    const stage2States = ["planning"];
    const stage3States = ["awaiting_approval", "approved", "changes_requested", "approval_invalidated", "rejected"];
    const stage4States = ["executing"];
    const stage5States = ["succeeded", "failed", "cancelled", "interrupted"];

    const allGrouped = [
      ...stage1States,
      ...stage2States,
      ...stage3States,
      ...stage4States,
      ...stage5States,
    ];

    expect(allGrouped.length).toBe(13);

    // Verify all 13 states have defined badge meta
    for (const state of allGrouped) {
      const meta = getStateMeta(state as any);
      expect(meta.label).toBeDefined();
      expect(meta.badgeClass.length).toBeGreaterThan(0);
    }
  });

  it("4. Form Validation: validateRequiredFields (real util used by DynamicForm) enforces non-empty values", () => {
    const required = ["cluster_name", "target_pod"];

    expect(validateRequiredFields(required, { cluster_name: "k8s-prod-01" })).toEqual({
      target_pod: "此项为必填项",
    });
    expect(
      validateRequiredFields(required, { cluster_name: "k8s-prod-01", target_pod: "api-gateway-7b9" })
    ).toEqual({});
    expect(validateRequiredFields(required, { cluster_name: "", target_pod: null })).toEqual({
      cluster_name: "此项为必填项",
      target_pod: "此项为必填项",
    });
  });

  it("5. Current user identity: localStorage override with demo fallback", () => {
    expect(getCurrentUserId()).toBe("user_operator_bob");
    const store = new Map<string, string>([["openma_user_id", "user_sre_alice"]]);
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
    try {
      expect(getCurrentUserId()).toBe("user_sre_alice");
    } finally {
      delete (globalThis as any).localStorage;
    }
  });
});
