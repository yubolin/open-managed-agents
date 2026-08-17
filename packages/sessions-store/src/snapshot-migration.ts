import type { AgentConfig } from "@open-managed-agents/shared";
import { hashJsonSnapshot } from "@open-managed-agents/shared";
import type { SqlClient } from "@open-managed-agents/sql-client";

export const SNAPSHOT_MIGRATION_STAGES = [
  "add_nullable_columns",
  "backfill_with_jcs",
  "enable_new_write_constraints",
] as const;

export async function backfillLegacySessionSnapshot(input: {
  agentSnapshot: AgentConfig | null;
  migratedAt: string;
}): Promise<{
  snapshotState: "finalized" | "legacy_unversioned";
  snapshotHash: string | null;
  snapshotFinalizedAt: string | null;
  hashAlgorithm: "sha256:jcs-rfc8785:v1" | null;
}> {
  if (input.agentSnapshot === null) {
    return {
      snapshotState: "legacy_unversioned",
      snapshotHash: null,
      snapshotFinalizedAt: null,
      hashAlgorithm: null,
    };
  }
  const hashed = await hashJsonSnapshot(input.agentSnapshot);
  return {
    snapshotState: "finalized",
    snapshotHash: hashed.configHash,
    snapshotFinalizedAt: input.migratedAt,
    hashAlgorithm: hashed.hashAlgorithm,
  };
}

/**
 * Phase-2 application backfill. Safe to resume: every write is conditioned on
 * snapshot_state IS NULL, so parallel replicas cannot overwrite a classified
 * row. Phase 3 (database NOT NULL/CHECK constraints) must only be enabled after
 * this returns with remaining=0 in the target environment.
 */
export async function backfillLegacySessionSnapshots(input: {
  sql: SqlClient;
  batchSize?: number;
  migratedAt?: number;
}): Promise<{ finalized: number; legacyUnversioned: number; remaining: number }> {
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 100, 1_000));
  const rows = await input.sql
    .prepare(
      `SELECT id, tenant_id, agent_snapshot FROM sessions
        WHERE snapshot_state IS NULL ORDER BY created_at, id LIMIT ?`,
    )
    .bind(batchSize)
    .all<{ id: string; tenant_id: string; agent_snapshot: string | null }>();
  let finalized = 0;
  let legacyUnversioned = 0;
  const migratedAt = input.migratedAt ?? Date.now();

  for (const row of rows.results ?? []) {
    if (row.agent_snapshot === null) {
      const result = await input.sql
        .prepare(
          `UPDATE sessions SET snapshot_state = 'legacy_unversioned'
            WHERE id = ? AND tenant_id = ? AND snapshot_state IS NULL`,
        )
        .bind(row.id, row.tenant_id)
        .run();
      legacyUnversioned += result.meta.changes;
      continue;
    }

    const parsed = JSON.parse(row.agent_snapshot) as AgentConfig;
    const hashed = await hashJsonSnapshot(parsed);
    const result = await input.sql
      .prepare(
        `UPDATE sessions
            SET agent_snapshot = ?, snapshot_state = 'finalized',
                snapshot_hash = ?, snapshot_finalized_at = ?
          WHERE id = ? AND tenant_id = ? AND snapshot_state IS NULL`,
      )
      .bind(
        JSON.stringify(hashed.normalized),
        hashed.configHash,
        migratedAt,
        row.id,
        row.tenant_id,
      )
      .run();
    finalized += result.meta.changes;
  }

  const remainingRow = await input.sql
    .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE snapshot_state IS NULL`)
    .first<{ count: number }>();
  return {
    finalized,
    legacyUnversioned,
    remaining: Number(remainingRow?.count ?? 0),
  };
}
