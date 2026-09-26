ALTER TABLE "realtime_sessions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "transcript_shares" ADD COLUMN "token" text;--> statement-breakpoint
ALTER TABLE "transcript_shares" ADD COLUMN "expires_at" timestamp with time zone;
