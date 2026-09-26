ALTER TABLE "glossary_terms" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "transcript_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "transcript_folders" ADD CONSTRAINT "transcript_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "starred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "tags" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_folder_id_transcript_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."transcript_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "transcript_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transcript_id" uuid NOT NULL,
  "text" text NOT NULL,
  "done" boolean DEFAULT false NOT NULL,
  "position" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
ALTER TABLE "transcript_tasks" ADD CONSTRAINT "transcript_tasks_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_shares" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "transcript_shares" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transcript_shares" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;
