ALTER TABLE "transcripts" ADD COLUMN "mode" text DEFAULT 'one_way' NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_checks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "audience_token_hash" text;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "audience_token" text;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "audience_include_audio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "audience_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "audience_revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "realtime_audience_token_hash_unique" ON "realtime_sessions" USING btree ("audience_token_hash");
