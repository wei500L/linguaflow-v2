ALTER TABLE "usage_ledger" ADD COLUMN IF NOT EXISTS "request_id" uuid;
ALTER TABLE "note_versions" ADD COLUMN IF NOT EXISTS "citations_verified" boolean;
