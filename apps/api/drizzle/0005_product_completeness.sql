ALTER TABLE "usage_ledger" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "transcript_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "kind" text DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "status" text DEFAULT 'settled' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "summary_billing" text;--> statement-breakpoint
ALTER TABLE "activation_codes" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_audit" ALTER COLUMN "admin_id" DROP NOT NULL;--> statement-breakpoint
CREATE TABLE "transcript_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"include_audio" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "transcript_shares" ADD CONSTRAINT "transcript_shares_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_share_hash_unique" ON "transcript_shares" USING btree ("token_hash");
