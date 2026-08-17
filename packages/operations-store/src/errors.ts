// Operations Workspace Domain Error Hierarchy & HTTP Status Code Mappings.

export abstract class OperationsError extends Error {
  abstract readonly statusCode: number;
  abstract readonly errorCode: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** 404 Anti-probing: used for non-existent OR cross-tenant access (D0 §4). */
export class RunNotFoundError extends OperationsError {
  readonly statusCode = 404;
  readonly errorCode = "RUN_NOT_FOUND";

  constructor(runId: string) {
    super(`Run not found: ${runId}`);
  }
}

export class ServiceTemplateNotFoundError extends OperationsError {
  readonly statusCode = 404;
  readonly errorCode = "TEMPLATE_NOT_FOUND";

  constructor(templateId: string) {
    super(`Service template not found: ${templateId}`);
  }
}

export class InactiveOrInvalidTemplateVersionError extends OperationsError {
  readonly statusCode = 400;
  readonly errorCode = "INACTIVE_OR_INVALID_TEMPLATE_VERSION";

  constructor(versionId: string) {
    super(`Service template version is inactive or invalid: ${versionId}`);
  }
}

/** 403 SoD Violation: Applicant cannot approve their own run (D0 §3). */
export class SoDViolationSelfApprovalError extends OperationsError {
  readonly statusCode = 403;
  readonly errorCode = "SOD_VIOLATION_SELF_APPROVAL_FORBIDDEN";

  constructor(runId: string, approverId: string) {
    super(`SoD violation: Creator (${approverId}) cannot approve own run ${runId}`);
  }
}

/** 403 Platform Admin has no bypass privilege for business approvals. */
export class AdminApprovalBypassForbiddenError extends OperationsError {
  readonly statusCode = 403;
  readonly errorCode = "ADMIN_APPROVAL_BYPASS_FORBIDDEN";

  constructor(adminId: string) {
    super(`Platform Admin (${adminId}) has no business approval privilege without approver role`);
  }
}

/** 409 CAS State Conflict: State changed concurrently (Base B §9-1). */
export class RunStateConflictError extends OperationsError {
  readonly statusCode = 409;
  readonly errorCode = "RUN_STATE_CONFLICT";

  constructor(runId: string, expectedState: string, actualState?: string) {
    super(
      `State transition conflict on run ${runId}: expected state '${expectedState}'${
        actualState ? `, but found '${actualState}'` : ""
      }`
    );
  }
}

/** 409 CAS Plan Drift: Plan hash mismatch at execution time (K2). */
export class PlanHashDriftError extends OperationsError {
  readonly statusCode = 409;
  readonly errorCode = "PLAN_HASH_DRIFT_INVALIDATED";

  constructor(runId: string) {
    super(`Plan content drifted after approval on run ${runId}. Execution blocked.`);
  }
}

/** 409 CAS Evidence Drift: Evidence snapshot hash mismatch at execution time (H1). */
export class EvidenceHashDriftError extends OperationsError {
  readonly statusCode = 409;
  readonly errorCode = "EVIDENCE_HASH_DRIFT_INVALIDATED";

  constructor(runId: string) {
    super(`Diagnosis evidence drifted after approval on run ${runId}. Execution blocked.`);
  }
}

/** 400 Audit validation error when tenant_id or actor is missing (D0 §5). */
export class AuditMissingRequiredFieldError extends OperationsError {
  readonly statusCode = 400;
  readonly errorCode = "AUDIT_MISSING_REQUIRED_FIELD";

  constructor(field: string) {
    super(`Missing required audit envelope field: ${field}`);
  }
}

export class InvalidStateTransitionError extends OperationsError {
  readonly statusCode = 400;
  readonly errorCode = "INVALID_STATE_TRANSITION";

  constructor(from: string, to: string) {
    super(`Illegal state transition from '${from}' to '${to}'`);
  }
}
