---
name: subagent-driven-development
description: Dispatch independent subagents for individual development tasks with code review checkpoints between iterations for rapid, controlled parallel development. Use when implementing features that can be decomposed into independent units of work.
---

# Subagent-Driven Development (SADD)

Accelerate development by dispatching independent subagents for parallelizable tasks, with mandatory review checkpoints between iterations.

## When to Use

- Implementing multiple independent features or modules simultaneously
- Building API endpoints that don't depend on each other
- Creating frontend components that can be developed in isolation
- Writing tests for existing code across multiple files
- Any task that can be decomposed into independent units of work

## Core Principles

### 1. Task Decomposition
Before dispatching subagents, decompose the work into independent units:

- Each unit must be **self-contained** (no cross-dependencies between subagent tasks)
- Each unit must have a **clear deliverable** (a file, a function, a test suite)
- Each unit must have **acceptance criteria** (what "done" looks like)

### 2. Contract-First Development
Define interfaces/contracts BEFORE dispatching subagents:

- API contracts (OpenAPI/Swagger schemas)
- Database models (ORM definitions)
- Type definitions (Pydantic models, TypeScript interfaces)
- Shared constants and enums

This prevents subagents from making conflicting assumptions.

### 3. Subagent Dispatch Protocol

For each independent task:

```
1. Create a clear, self-contained task description
2. Include all necessary context (file paths, schemas, conventions)
3. Specify the expected output format
4. Set completion criteria
5. Dispatch the subagent
```

### 4. Review Checkpoints

After EACH subagent completes its task:

- **Verify** the output meets acceptance criteria
- **Check** for conflicts with other subagent outputs
- **Validate** adherence to project conventions (CLAUDE.md, coding standards)
- **Test** the output if applicable (run tests, lint, type-check)
- **Integrate** the output into the main codebase only after review passes

### 5. Iteration Protocol

If a subagent's output fails review:

1. Document the specific issues found
2. Provide the feedback as context for the next iteration
3. Re-dispatch with corrective instructions
4. Maximum 3 retry attempts before escalating to human

## CMDB Project-Specific Rules

### Mandatory Checks for Every Subagent Output

- [ ] `tenant_id` field is present in ALL database queries (WHERE clause)
- [ ] No raw SQL without parameterized queries
- [ ] All API endpoints require authentication middleware
- [ ] Pydantic models include field descriptions
- [ ] Type hints on all function signatures
- [ ] Error handling with proper HTTP status codes

### Subagent Task Template

```markdown
## Task: [Name]
**Deliverable:** [What file(s) to create/modify]
**Context:** [Relevant existing code, schemas, conventions]
**Acceptance Criteria:**
- [ ] Criterion 1
- [ ] Criterion 2
**Constraints:**
- Must include tenant_id isolation
- Must follow FastAPI router conventions
- Must include unit tests
```

## Workflow Example

```
Human: "Build CRUD APIs for assets, projects, and relations"

Step 1: Define shared contracts (Pydantic schemas)
Step 2: Dispatch 3 subagents in parallel:
  - Subagent A: Asset CRUD router
  - Subagent B: Project CRUD router  
  - Subagent C: Relation CRUD router
Step 3: Review checkpoint for each output
Step 4: Integration testing
Step 5: Human approval
```

## Important Guidelines

- **Never skip review checkpoints** — every subagent output MUST be reviewed
- **Contract-first always** — define interfaces before implementation
- **Fail fast** — if a subagent is stuck after 3 attempts, escalate
- **Document decisions** — log why specific approaches were chosen
- **Atomic commits** — each subagent's work should be one logical commit
