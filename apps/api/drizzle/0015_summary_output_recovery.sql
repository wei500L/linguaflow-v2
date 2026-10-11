ALTER TABLE "summary_requests" ADD COLUMN IF NOT EXISTS "output_markdown" text;
ALTER TABLE "summary_requests" ADD COLUMN IF NOT EXISTS "output_citation_hashes" jsonb;
ALTER TABLE "summary_requests" ADD COLUMN IF NOT EXISTS "output_language" text;
ALTER TABLE "summary_requests" ADD COLUMN IF NOT EXISTS "output_model" text;
ALTER TABLE "summary_requests" ADD COLUMN IF NOT EXISTS "output_saved_at" timestamp with time zone;
