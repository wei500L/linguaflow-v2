CREATE TABLE IF NOT EXISTS "summary_providers" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"api_base" text NOT NULL,
	"api_key_cipher" text,
	"model" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "record_audio" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_markdown" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_error" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_template" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_language" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_model" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_source_hash" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "audio_rel_path" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "audio_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "audio_format" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "audio_bytes" integer;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "audio_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "audio_error" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "summary_providers" ADD CONSTRAINT "summary_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
