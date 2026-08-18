// Drizzle adapter for the SSE ticket store (Base F3) — backs the
// SseTicketStorePort with the sse_tickets table so multi-replica
// deployments share one ticket truth.
//
// Dialect-blind like adapters/drizzle.ts: cf-auth table object + the
// _shared terminator helpers. consume() rides DELETE ... RETURNING —
// atomic single-use on SQLite / D1 / PG alike (getAll feature-detects
// the sqlite .all() terminator vs the awaitable PG chain).
//
// NOTE(pg): the sqlite-typed table maps PG bigint columns through a
// pass-through value mapper, so postgres-js may hand back strings for
// expires_at. Row mapping below coerces with Number() — normalization
// at the mapping boundary, not dialect branching.

import { eq, lt } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  runOnce,
  type OmaDb,
} from "@open-managed-agents/db-schema";
import { sse_tickets } from "@open-managed-agents/db-schema/cf-auth";
import type {
  SseTicketRecord,
  SseTicketStorePort,
} from "../sse-tickets";

interface SseTicketRow {
  token: string;
  tenant_id: string;
  user_id: string;
  run_id: string | null;
  expires_at: number | string;
}

function toRecord(row: SseTicketRow): SseTicketRecord {
  return {
    token: row.token,
    tenantId: row.tenant_id,
    userId: row.user_id,
    runId: row.run_id ?? undefined,
    expiresAt: Number(row.expires_at),
  };
}

const SWEEP_INTERVAL_MS = 30_000;

export class DrizzleSseTicketStore implements SseTicketStorePort {
  private readonly db: ReturnType<typeof asBuilder>;
  private lastSweepAt = 0;

  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async issue(record: SseTicketRecord): Promise<void> {
    // Opportunistic reaping, same cadence as the in-memory default —
    // consumed tickets are already gone; this clears never-redeemed ones.
    const now = record.expiresAt;
    if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) {
      this.lastSweepAt = now;
      await runOnce(this.db.delete(sse_tickets).where(lt(sse_tickets.expires_at, now)));
    }
    await runOnce(
      this.db.insert(sse_tickets).values({
        token: record.token,
        tenant_id: record.tenantId,
        user_id: record.userId,
        run_id: record.runId ?? null,
        expires_at: record.expiresAt,
        created_at: now,
      }),
    );
  }

  async consume(token: string): Promise<SseTicketRecord | null> {
    const rows = await getAll(
      this.db
        .delete(sse_tickets)
        .where(eq(sse_tickets.token, token))
        .returning(),
    );
    const row = rows[0] as SseTicketRow | undefined;
    return row ? toRecord(row) : null;
  }

  async sweepExpired(nowMs: number): Promise<number> {
    const rows = await getAll(
      this.db
        .delete(sse_tickets)
        .where(lt(sse_tickets.expires_at, nowMs))
        .returning(),
    );
    return rows.length;
  }
}
