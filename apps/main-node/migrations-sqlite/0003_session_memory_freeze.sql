-- Memory bindings freeze marker. Set by the Node session registry the
-- moment a session machine snapshots its mount list; the binding route's
-- conditional INSERT refuses to land new rows once it is non-NULL. This
-- is persisted (not in-process) so the 409 gate holds across multiple
-- oma-server replicas against one Postgres — no sticky routing needed.
-- Node-only concern: the shared CF sessions schema never gets this
-- column, hence a hand-written Node migration instead of drizzle-kit.
ALTER TABLE sessions ADD COLUMN memory_frozen_at integer;
