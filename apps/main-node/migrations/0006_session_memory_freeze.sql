-- Memory bindings freeze marker. Set by the Node session registry the
-- moment a session machine snapshots its mount list; the binding route's
-- conditional INSERT refuses to land new rows once it is non-NULL. This
-- is persisted (not in-process) so the 409 gate holds across multiple
-- oma-server replicas against one Postgres — no sticky routing needed.
-- Node-only concern: the shared CF sessions schema never gets this
-- column, hence a hand-written Node migration instead of drizzle-kit.
-- Renumbered during the Task-2 merge (was 0003 on the feature branch):
-- main gained 0003_feishu_publication_first / 0004_needy_the_renegades in
-- the meantime, so the freeze marker lands as 0005 here. No meta snapshot
-- accompanies it ON PURPOSE: memory_frozen_at is not declared in the
-- drizzle schema (CF never gets the column), so a snapshot containing it
-- would make the next drizzle-kit generate emit a DROP COLUMN.

ALTER TABLE "sessions" ADD COLUMN "memory_frozen_at" integer;
