CREATE TABLE IF NOT EXISTS "login_attempts" (
	"email" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS realtime_sessions_one_active_per_user ON realtime_sessions (user_id) WHERE ended_at IS NULL;
