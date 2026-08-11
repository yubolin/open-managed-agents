# feishu-echo spike (OMA × Feishu)

Throwaway PoC for the Feishu multi-agent integration PRD. Validates the
riskiest unknowns **before** any Phase 0/1 build:

- Feishu WebSocket (长连接) event receipt + `message_id` dedup.
- Driving one real OMA agent turn over the **same HTTP boundary** the future
  Feishu Provider will use (`POST /v1/sessions/:id/messages` + SSE).
- End-to-end latency baseline for the PRD's 120s conclusion SLA.

It is deliberately **out of the pnpm workspace** and talks to OMA purely over
HTTP — no `ProviderId` change, no core-code touch.

## What it is not

No multi-agent state machine, no personas, no cards, no memory stores, no
Runtime Tool Authorization Gateway. Those are Phase 0 / Phase 1.

## Prerequisites

1. **Feishu self-built app** with WebSocket (长连接) enabled and scopes:
   `im:message`, `im:message:send_as_bot`, `im:chat`. Bot invited to a test
   group. → `FEISHU_APP_ID` / `FEISHU_APP_SECRET`.
2. **OMA main-node running locally** (`apps/main-node`) with a configured agent
   + model creds, reachable at `OMA_BASE_URL`.
3. **An OMA API key** (`POST /v1/api_keys`) and **a session** created in the
   same tenant → `OMA_API_KEY` / `OMA_SESSION_ID`.

## Setup

```bash
cd spikes/feishu-echo
cp .env.example .env   # fill in real values
pnpm install --ignore-workspace
pnpm typecheck
```

`--ignore-workspace` keeps the spike's deps out of the monorepo install.
`pnpm-workspace.yaml` commits an `allowBuilds` decision (deny esbuild /
protobufjs postinstalls — neither is needed to run tsx) so pnpm v11's
run-wrapper doesn't fail with `ERR_PNPM_IGNORED_BUILDS`.

## Run

```bash
pnpm start
# or, with auto-reload:
pnpm dev
```

`@` the bot in the test group with a question. Each turn logs one JSON line:

```json
{"level":"info","op":"turn.ok","chatId":"oc_…","totalMs":7421,"bridgeMs":7310,"sendMs":98,"ok":true,"replyChars":412,…}
```

- `bridgeMs` ≈ model round-trip — the dominant term for the 120s SLA.
- `sendMs` ≈ Feishu send API.
- Duplicates log `op:dedup.skip` at debug.

`MODE=echo` runs the bridge locally (no model call) to validate Feishu plumbing
alone.

## What to record from the run

- P50/P95 `bridgeMs` for typical ops questions → feeds the Phase 0 SDS and the
  120s feasibility call (does a single round-trip already eat most of the
  budget? how many parallel rounds fit?).
- WebSocket reconnect behavior under network blips.
- Whether `message_id` dedup catches Feishu redelivery.

## Known limitations / assumptions

- lark SDK signatures target `@larksuiteoapi/node-sdk@1.73.0`
  (`WSClient`, `EventDispatcher.register`, `client.im.message.create`). If a
  signature differs, `pnpm typecheck` will flag it — fix in `src/lark.ts`.
- Text messages only; rich content / cards are out of scope.
- One OMA session for all Feishu chats (chat→session mapping is Phase 1).
- Dedup is in-memory (survives only the process).
