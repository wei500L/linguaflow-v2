CREATE TABLE "user_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "fingerprint_hash" text NOT NULL,
  "device_id" text NOT NULL,
  "last_ip" text,
  "user_agent" text,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_user_fp_device_unique" ON "user_devices" USING btree ("user_id","fingerprint_hash","device_id");--> statement-breakpoint
CREATE INDEX "user_devices_fingerprint_hash_idx" ON "user_devices" USING btree ("fingerprint_hash");--> statement-breakpoint
CREATE INDEX "user_devices_device_id_idx" ON "user_devices" USING btree ("device_id");--> statement-breakpoint
CREATE TABLE "device_claims" (
  "key" text PRIMARY KEY NOT NULL,
  "claimed_by" uuid NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "fingerprint_hash" text;--> statement-breakpoint
ALTER TABLE "realtime_sessions" ADD COLUMN "device_id" text;
