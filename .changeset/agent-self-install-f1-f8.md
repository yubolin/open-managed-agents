---
"@openma/sdk": minor
"@openma/cli": minor
---

Agent self-install skill onboarding (F1–F8, SDS agent-self-install v0.2). Adds SDK
support for `search_skill` / `install_skill` / `attach_skill` and a CLI flow to
install pinned skills from ClawHub. The agent update route now requires
`version` (optimistic concurrency, 428 Precondition Required) only when the
update touches the `skills` array — other updates keep the legacy silent-etag
bump so non-skill callers don't break.