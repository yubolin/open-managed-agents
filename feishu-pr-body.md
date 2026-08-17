## Summary

Adds a **Feishu (Lark)** integration to Open Managed Agents, alongside the existing Slack / GitHub / Linear providers. This brings the full publish → configure → live lifecycle, including an **outbound WebSocket long-connection runner** so a Feishu bot needs no public webhook tunnel to receive messages.

The change is split into layered, conventional commits (schema → package → wiring → runner → console → docs).

## What's included

- **DB schema** (`packages/db-schema`): Feishu publication/installation tables + a D1 adapter, the generated Drizzle migrations for both Node-SQLite and Node-Postgres, and the Cloudflare integrations migration.
- **`@open-managed-agents/feishu` package**: a worker-compatible provider (event dispatch, publication/installation repos with WebCrypto AES-GCM credential encryption at rest), a Feishu OpenAPI client (tenant-access-token mint + cache + single-flight), a webhook frame parser/signature verifier, and the installation/install-proxy lifecycle.
- **Integrations wiring**: the Feishu provider registered in `apps/integrations`, publication-first install routes, and the shared install-proxy gateway entry.
- **`apps/main-node` WS runner** (`src/lib/ws-feishu-runner.ts`): the production event-ingest path. Dials out to Feishu via the official `@larksuiteoapi/node-sdk` `WSClient`, drives the `awaiting_install → live` status flip on a successful handshake, dedups redelivered frames, and dispatches into agent sessions. **Opt-in** via `FEISHU_WS_RUNNER=1`.
- **Console UI**: Feishu integration list page, publish wizard, and workspace view.
- **Docs**: PRD, session lifecycle, phase-0 SDS, secrets design, and an ADR (EN + zh-CN).

## How credentials flow

Credentials are **never** read from env vars. The Console publish wizard issues a short-lived `formToken` (JWT, 60 min); the user fills appId / appSecret / encryptKey / verificationToken on a rendered setup page; the secret is **AES-GCM encrypted** before being persisted to the `feishu_publications` row (`status → credentials_filled`). The runner decrypts it at runtime via the repo.

## Commit breakdown

1. `feat(db)` — feishu publication/installation schema, D1 adapter, migration (+ node sqlite/pg ops migrations)
2. `feat(feishu)` — `@open-managed-agents/feishu` package
3. `feat(integrations)` — provider wiring, publication-first install routes, gateway
4. `feat(main-node)` — WS long-connection runner + install-bridge wiring
5. `chore(deps)` — `better-sqlite3` ^11.5 → ^13.0 (Node 24)
6. `feat(console)` — integration pages + publish wizard
7. `docs(feishu)` — PRD, lifecycle, SDS, secrets, ADRs
8. `chore` — gitignore local D1 persist + coverage dirs

## Testing

- `@open-managed-agents/feishu` — 70 unit tests (API client, webhook parse/signature, provider dispatch, repos).
- `apps/main-node` — WS-runner orchestration (envelope reconstruction, dedup, status flip, backoff, error isolation) + feishu-ops table schema/migration tests (FK=ON correctness and FK=OFF prod-shape trigger enforcement).
- `integrations-adapters-cf` — D1 feishu adapter tests.
- Console feishu-client tests.
- Full repo `tsc --noEmit` + node-app typecheck clean.

## Out of scope / notes

- **Single-replica only** for the WS runner (documented phase-1 prerequisite). No leader election yet; `recordIfNew` dedup protects against duplicate delivery if two replicas ever connect.
- The WS runner has been unit-tested but **not yet exercised against real Feishu app credentials** end-to-end — hence the opt-in gate rather than on-by-default.
- Depends on `@larksuiteoapi/node-sdk` (Node-only; added to `apps/main-node` only, not the worker-compatible `packages/feishu`).

Happy to restructure commits, split the PR, or adjust scope based on maintainer feedback.
