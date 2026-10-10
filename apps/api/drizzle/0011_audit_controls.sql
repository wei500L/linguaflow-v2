ALTER TABLE "users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_ip" text;--> statement-breakpoint
UPDATE "transcript_shares" SET "expires_at" = "created_at" + interval '30 days' WHERE "expires_at" IS NULL;--> statement-breakpoint
UPDATE "transcript_shares" SET "token" = NULL;--> statement-breakpoint
UPDATE "realtime_sessions" SET "audience_expires_at" = "created_at" + interval '30 days' WHERE "audience_token_hash" IS NOT NULL AND "audience_expires_at" IS NULL;--> statement-breakpoint
UPDATE "realtime_sessions" SET "audience_token" = NULL;
