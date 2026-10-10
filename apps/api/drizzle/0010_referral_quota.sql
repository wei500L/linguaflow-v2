ALTER TABLE "users" ADD COLUMN "invite_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_invite_code_unique" ON "users" USING btree ("invite_code");--> statement-breakpoint
CREATE TABLE "referrals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "inviter_id" uuid NOT NULL,
  "invitee_id" uuid,
  "invitee_email_identity" text NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "signup_ip" text,
  "fingerprint_hash" text,
  "device_id" text,
  "weak_device" boolean DEFAULT false NOT NULL,
  "qualified_session_id" uuid,
  "invitee_granted_seconds" integer DEFAULT 0 NOT NULL,
  "inviter_granted_seconds" integer DEFAULT 0 NOT NULL,
  "granted_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_invitee_email_identity_unique" ON "referrals" USING btree ("invitee_email_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_invitee_id_unique" ON "referrals" USING btree ("invitee_id") WHERE "invitee_id" is not null;--> statement-breakpoint
CREATE INDEX "referrals_inviter_created_idx" ON "referrals" USING btree ("inviter_id", "created_at");--> statement-breakpoint
CREATE TABLE "auth_ip_limits" (
  "ip" text NOT NULL,
  "purpose" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "hits" integer NOT NULL,
  CONSTRAINT "auth_ip_limits_pk" PRIMARY KEY("ip","purpose")
);
