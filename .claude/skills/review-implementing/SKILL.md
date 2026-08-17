---
name: review-implementing
description: Process and implement code review feedback systematically. Use when user provides reviewer comments, PR feedback, code review notes, or asks to implement suggestions from reviews.
---

# Review Feedback Implementation

Systematically process and implement changes based on code review feedback.

## When to Use

- Provides reviewer comments or feedback
- Pastes PR review notes
- Mentions implementing review suggestions
- Says "address these comments" or "implement feedback"
- Shares list of changes requested by reviewers

## Systematic Workflow

### 1. Parse Reviewer Notes

Identify individual feedback items:
- Split numbered lists (1., 2., etc.)
- Handle bullet points or unnumbered feedback
- Extract distinct change requests
- Clarify ambiguous items before starting

### 2. Create Todo List

Create actionable tasks from feedback:
- Each feedback item becomes one or more todos
- Break down complex feedback into smaller tasks
- Make tasks specific and measurable
- Mark first task as `in_progress` before starting

Example:
```
- Add type hints to extract function
- Fix duplicate tag detection logic
- Update docstring in chain.py
- Add unit test for edge case
```

### 3. Implement Changes Systematically

For each todo item:

**Locate relevant code:**
- Search for functions/classes mentioned
- Find files by pattern
- Read current implementation

**Make changes:**
- Follow project conventions
- Preserve existing functionality unless changing behavior

**Verify changes:**
- Check syntax correctness
- Run relevant tests if applicable
- Ensure changes address reviewer's intent

**Update status:**
- Mark todo as `completed` immediately after finishing
- Move to next todo (only one `in_progress` at a time)

### 4. Handle Different Feedback Types

**Code changes:**
- Follow type hint conventions (PEP 604/585)
- Maintain consistent style

**New features:**
- Create new files if needed
- Add corresponding tests
- Update documentation

**Documentation:**
- Update docstrings following project style
- Keep explanations concise

**Tests:**
- Write tests as functions, not classes
- Use descriptive names
- Follow pytest conventions

**Refactoring:**
- Preserve functionality
- Improve code structure
- Run tests to verify no regressions

### 5. CMDB-Specific Review Checks

After implementing all review changes, perform these mandatory checks:

- [ ] All database queries filter by `tenant_id`
- [ ] No sensitive data exposed in API responses (emails, tokens)  
- [ ] JSONB attribute access uses safe navigation (`.get()`)
- [ ] All new endpoints have OpenAPI descriptions
- [ ] Error responses follow consistent format
- [ ] No N+1 query patterns introduced

### 6. Validation

After implementing changes:
- Run affected tests
- Check for linting errors
- Verify changes don't break existing functionality

### 7. Communication

Keep user informed:
- Update progress in real-time
- Ask for clarification on ambiguous feedback
- Report blockers or challenges
- Summarize changes at completion

## Edge Cases

**Conflicting feedback:**
- Ask user for guidance
- Explain conflict clearly

**Breaking changes required:**
- Notify user before implementing
- Discuss impact and alternatives

**Tests fail after changes:**
- Fix tests before marking todo complete
- Ensure all related tests pass

## Important Guidelines

- **Always track progress** systematically
- **Mark todos completed immediately** after each item
- **Only one todo in_progress** at any time
- **Don't batch completions** — update status in real-time
- **Ask questions** for unclear feedback
- **Run tests** if changes affect tested code
- **Follow project conventions** for all code changes
