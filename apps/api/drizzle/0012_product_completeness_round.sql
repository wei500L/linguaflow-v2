CREATE TABLE IF NOT EXISTS "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language_a" text NOT NULL,
	"language_b" text NOT NULL,
	"mode" text DEFAULT 'one_way' NOT NULL,
	"glossary_id" uuid,
	"record_audio" boolean DEFAULT true NOT NULL,
	"summary_template" text DEFAULT 'classroom' NOT NULL,
	"title_pattern" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "note_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"template" text,
	"input_version" integer,
	"provider" text,
	"body" text NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"source" text DEFAULT 'server' NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_markers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"transcript_id" uuid,
	"kind" text NOT NULL,
	"note" text,
	"wall_ms" integer,
	"audio_ms" integer,
	"segment_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_token_chunks" (
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"tokens" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_chunks_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "summary_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"transcript_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"input_version" integer NOT NULL,
	"provider" text NOT NULL,
	"template" text NOT NULL,
	"quote_seconds" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"note_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"session_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"diagnostics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "owner_instance_id" text;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "owner_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "checkpoint_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "checkpoint_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "audio_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "active_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "save_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "save_error" text;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "persisted_token_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "segment_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "speaker_names" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "gaps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "share_intent" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "audience_keep_after" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "course_id" uuid;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "recording_rel_path" text;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD COLUMN "source_hash" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "record_status" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "course_id" uuid;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "gaps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_input_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_citation_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "note_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "courses" ADD CONSTRAINT "courses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "courses" ADD CONSTRAINT "courses_glossary_id_glossaries_id_fk" FOREIGN KEY ("glossary_id") REFERENCES "public"."glossaries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_events" ADD CONSTRAINT "product_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_markers" ADD CONSTRAINT "session_markers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_markers" ADD CONSTRAINT "session_markers_session_id_realtime_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."realtime_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_markers" ADD CONSTRAINT "session_markers_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_token_chunks" ADD CONSTRAINT "session_token_chunks_session_id_realtime_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."realtime_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "summary_requests" ADD CONSTRAINT "summary_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "summary_requests" ADD CONSTRAINT "summary_requests_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "note_versions_transcript_idx" ON "note_versions" USING btree ("transcript_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_events_dedupe_unique" ON "product_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_events_name_created_idx" ON "product_events" USING btree ("name","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_markers_session_idx" ON "session_markers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_markers_transcript_idx" ON "session_markers" USING btree ("transcript_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "summary_requests_user_key_unique" ON "summary_requests" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_requests_status_idx" ON "support_requests" USING btree ("status","created_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "realtime_sessions" ADD CONSTRAINT "realtime_sessions_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transcripts_user_deleted_idx" ON "transcripts" USING btree ("user_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transcripts_session_unique" ON "transcripts" USING btree ("session_id");--> statement-breakpoint
UPDATE "realtime_sessions" SET "audience_keep_after" = true WHERE "audience_token_hash" IS NOT NULL AND "audience_revoked_at" IS NULL;