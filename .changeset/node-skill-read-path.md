---
"@open-managed-agents/main-node": minor
"@open-managed-agents/agent": minor
---

Node skill read-path parity with CF (SDS §2.7 update): SessionRegistry now
resolves the frozen agent snapshot's skills into `skill:<id>` platform
reminders (custom SKILL.md inlined byte-identical to CF's `<skill name>`
format) and mounts custom skill files into the sandbox at a workdir-relative
`.skills/<name>/` base. The Node skill KV moved from InMemoryKvStore to
SqlKvStore so install metadata survives process restarts. skills.ts resolver
signatures narrowed from KVNamespace/R2Bucket to structural ports so both
runtimes share one implementation; resolveCustomSkills gained an optional
skillsDirBase for the fallback reminder path.
