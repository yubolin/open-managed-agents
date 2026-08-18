CREATE TABLE "sse_tickets" (
	"token" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_sse_tickets_expires" ON "sse_tickets" USING btree ("expires_at");