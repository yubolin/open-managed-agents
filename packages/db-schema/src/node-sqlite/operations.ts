// Operations Workspace tables (Node self-host SQLite variant).
//
// SQLite-typed mirror of cf-auth/operations.ts — integer for epoch-ms
// timestamps and counters. The constraint shape (composite UNIQUE, composite
// FKs with tenant_id, CHECK constraints, MATCH SIMPLE nullable FK) is
// identical to the CF variant; see that file for the design rationale.
//
// Node-only: the node-sqlite barrel re-exports cf-auth/* unchanged, so this
// file exists to add FK=OFF trigger documentation parity. The actual tables
// are imported from ../cf-auth/operations via the barrel — no duplication.
//
// SQLite prod runs PRAGMA foreign_keys = OFF. The migration SQL
// (migrations-sqlite/, plus the D1 twin in apps/main/migrations/ — see
// cf-auth/operations.ts for the disputed-D1-default ruling) carries
// hand-written enforcement triggers that mirror every declarative FK
// semantic — child INSERT/UPDATE existence (MATCH SIMPLE), parent DELETE
// (CASCADE / NO ACTION), parent UPDATE (NO ACTION).
// The FK=OFF vitest suite validates the trigger coverage.
//
// This file is intentionally empty of table definitions — the node-sqlite
// barrel (index.ts) re-exports ../cf-auth which includes operations.ts.
// This stub documents the node-sqlite-specific migration trigger requirement.

// Re-exported via ../cf-auth in the node-sqlite barrel.
// No additional table definitions needed — SQLite types match D1.
