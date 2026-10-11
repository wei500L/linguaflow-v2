ALTER TABLE "note_versions" ADD COLUMN IF NOT EXISTS "input_hash" text;
ALTER TABLE "note_versions" ADD COLUMN IF NOT EXISTS "output_language" text;
ALTER TABLE "note_versions" ADD COLUMN IF NOT EXISTS "citation_hashes" jsonb;
ALTER TABLE "note_versions" ADD COLUMN IF NOT EXISTS "source_hash" text;
ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "summary_citations_verified" boolean DEFAULT true NOT NULL;
