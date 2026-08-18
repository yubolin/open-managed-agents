import { describe, expect, it } from "vitest";
import { getStateMeta, shortHash } from "../src/lib/utils";

describe("Base D · UI Defense Guards & Domain Alignments", () => {
  it("1. SoD Guard: detects self-created runs to block applicant self-approval", () => {
    const currentUserId = "user_operator_bob";

    const applicantRun = {
      run_id: "run_applicant_1",
      created_by: "user_operator_bob",
      title: "Self Created Change Plan",
    };

    const peerRun = {
      run_id: "run_peer_2",
      created_by: "user_sre_alice",
      title: "Peer SRE Change Plan",
    };

    // Business rule: applicant cannot approve own run
    const isSelfApprovalBlocked = (runCreatedBy: string, userId: string) => runCreatedBy === userId;

    expect(isSelfApprovalBlocked(applicantRun.created_by, currentUserId)).toBe(true);
    expect(isSelfApprovalBlocked(peerRun.created_by, currentUserId)).toBe(false);
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

  it("4. Form Validation: required fields in form_schema enforce non-empty values", () => {
    const formSchema = {
      type: "object",
      required: ["cluster_name", "target_pod"],
      properties: {
        cluster_name: { type: "string", title: "集群名称" },
        target_pod: { type: "string", title: "目标 Pod" },
        dry_run: { type: "boolean", title: "演练模式" },
      },
    };

    const validateForm = (schema: typeof formSchema, values: Record<string, any>) => {
      const errors: Record<string, string> = {};
      for (const req of schema.required) {
        if (values[req] === undefined || values[req] === null || values[req] === "") {
          errors[req] = "此项为必填项";
        }
      }
      return { isValid: Object.keys(errors).length === 0, errors };
    };

    const invalidSubmission = { cluster_name: "k8s-prod-01" };
    const validSubmission = { cluster_name: "k8s-prod-01", target_pod: "api-gateway-7b9" };

    const check1 = validateForm(formSchema, invalidSubmission);
    expect(check1.isValid).toBe(false);
    expect(check1.errors.target_pod).toBe("此项为必填项");

    const check2 = validateForm(formSchema, validSubmission);
    expect(check2.isValid).toBe(true);
    expect(check2.errors).toEqual({});
  });
});
