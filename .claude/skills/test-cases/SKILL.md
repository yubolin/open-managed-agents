---
name: test-cases
description: This skill should be used when generating comprehensive test cases from PRD documents or user requirements. Triggers when users request test case generation, QA planning, test scenario creation, or need structured test documentation. Produces detailed test cases covering functional, edge case, error handling, and state transition scenarios.
license: MIT
---

# Test Cases Generator

This skill generates comprehensive, requirement-driven test cases from PRD documents or user requirements.

## Purpose

Transform product requirements into structured test cases that ensure complete coverage of functionality, edge cases, error scenarios, and state transitions. The skill follows a pragmatic testing philosophy: test what matters, ensure every requirement has corresponding test coverage, and maintain test quality over quantity.

## When to Use

- When a feature is described via PRD, user story, or requirement document
- When preparing QA plans before or after development
- When setting up a dedicated Test Agent to verify a feature
- When reviewing whether existing tests cover all scenarios
- When a bug is reported and regression tests are needed

## Test Case Categories

| Code | Category | Description |
|------|----------|-------------|
| `TC-F` | Functional | Normal happy-path scenarios that verify core requirements |
| `TC-E` | Edge Case | Boundary values, empty inputs, maximum limits |
| `TC-ERR` | Error Handling | Invalid inputs, missing required fields, unauthorized access |
| `TC-ST` | State Transition | Sequences of operations that change system state |

## Workflow

### Step 1 — Gather Requirements

Read the PRD, user story, or feature description. Extract:
- **What** the feature does (core functionality)
- **Who** uses it (actor/role)
- **When** it applies (preconditions)
- **What** success looks like (expected outcomes)
- **What** failure looks like (error conditions)

### Step 2 — Extract Test Scenarios

For each requirement, identify:
1. The primary success scenario
2. Boundary conditions (min/max values, empty state)
3. Invalid input scenarios
4. State-dependent behaviors
5. Permission/authorization scenarios

### Step 3 — Structure Test Cases

Write each test case using this template:

```markdown
### TC-F-001: [Descriptive Name]

**Category**: Functional / Edge Case / Error / State Transition
**Priority**: P0 (blocker) | P1 (high) | P2 (medium) | P3 (low)
**Preconditions**: What must be true before running this test

**Steps**:
1. [Action 1]
2. [Action 2]
3. [Action 3]

**Expected Result**: [Precise, verifiable outcome]
**Actual Result**: [ ] Pass  [ ] Fail
**Notes**: Any edge conditions or special notes
```

### Step 4 — Validate Coverage

Cross-check that every requirement item has at least:
- 1 functional (TC-F) test
- 1 edge case (TC-E) test  
- 1 error handling (TC-ERR) test

### Step 5 — Output

Write test cases to a dedicated file:
```
docs/test-cases/TC-[feature-name]-[date].md
```

## CMDB-Specific Coverage Checklist

For every API feature, test cases must cover:

- [ ] **Happy path** — authenticated user, valid data, correct response
- [ ] **Tenant isolation** — cannot read/write another tenant's data
- [ ] **Authentication** — 401 when no token / expired token
- [ ] **Authorization** — 403 when insufficient role
- [ ] **Validation** — 422 for missing required fields, invalid formats
- [ ] **Pagination** — correct `page`, `page_size`, `total` in list responses
- [ ] **Empty state** — empty list returns `[]` not error
- [ ] **Not found** — 404 for non-existent resource ID
- [ ] **Idempotency** — duplicate create returns proper error or upserts correctly

## Example Test Case Set

```markdown
## Feature: Report Download (POST /reports/generate)

### TC-F-001: Admin can generate XLSX report from template
**Priority**: P0
**Preconditions**: Logged in as admin, template "月度资产报表" exists

**Steps**:
1. Click "生成" next to template in /reports
2. Wait for download prompt

**Expected Result**: Browser downloads an .xlsx file with correct filename pattern
`report_<template_name>_<timestamp>.xlsx`

---

### TC-E-001: Report with no assets returns empty Excel
**Priority**: P1  
**Preconditions**: Template exists, no assets match filter

**Steps**:
1. Create template with filter `asset_type=nonexistent`
2. Click "生成"

**Expected Result**: Downloads .xlsx with header row only, no data rows

---

### TC-ERR-001: Unauthenticated user cannot download report
**Priority**: P0
**Preconditions**: Not logged in

**Steps**:
1. Directly access `/api/v1/reports/download/<id>?tenant=xxx` without token

**Expected Result**: 404 or returns template not found (tenant mismatch), no file downloaded

---

### TC-ST-001: Generate history is updated after download
**Priority**: P1
**Preconditions**: Template exists, logged in as admin

**Steps**:
1. Note current "上次生成" time
2. Click "生成"
3. Navigate to "生成历史" tab

**Expected Result**: New entry appears in history with correct filename, format, and timestamp
```

## Output File Format

```
docs/
└── test-cases/
    ├── TC-reports-download-20260328.md
    ├── TC-assets-crud-20260325.md
    └── TC-validation-engine-20260320.md
```

## Important Guidelines

- **One test case = one verifiable outcome** — don't bundle multiple assertions
- **Use concrete data** — specify exact values, not vague descriptions
- **State the preconditions explicitly** — tests must be reproducible
- **Set Priority** — P0 tests block release, P1/P2/P3 are nice-to-have
- **Cover the unhappy paths** — most bugs live in error handling, not happy path
- **Reference API contracts** — link to the relevant endpoint in backend `CLAUDE.md`
