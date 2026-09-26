ALTER TABLE "realtime_sessions" ADD COLUMN "max_session_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "reserved_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "claimed_at" timestamp with time zone;