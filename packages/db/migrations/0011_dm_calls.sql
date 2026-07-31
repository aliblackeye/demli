-- 0011 DM calls (ADR 0012). Additive + non-breaking, safe on the live database:
-- one new table (`dm_calls`) and one nullable column (`channels.livekit_room`,
-- default NULL ⇒ every existing voice channel keeps room = id). `status`/`media`
-- are plain `text`, NOT a pg enum — so the partial unique index below can key on
-- the status literals in this same single-transaction migration without tripping
-- the migrator's "unsafe use of new value" guard (plan §Wave 1). Every statement
-- guards itself (IF NOT EXISTS / duplicate_object) so a partial re-apply is safe.
CREATE TABLE IF NOT EXISTS "dm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dm_id" uuid NOT NULL,
	"room_name" text NOT NULL,
	"caller_id" uuid NOT NULL,
	"callee_id" uuid NOT NULL,
	"media" text NOT NULL,
	"status" text DEFAULT 'ringing' NOT NULL,
	"upgraded_to_group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "livekit_room" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_calls" ADD CONSTRAINT "dm_calls_dm_id_friend_groups_id_fk" FOREIGN KEY ("dm_id") REFERENCES "public"."friend_groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_calls" ADD CONSTRAINT "dm_calls_caller_id_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_calls" ADD CONSTRAINT "dm_calls_callee_id_users_id_fk" FOREIGN KEY ("callee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_calls" ADD CONSTRAINT "dm_calls_upgraded_to_group_id_friend_groups_id_fk" FOREIGN KEY ("upgraded_to_group_id") REFERENCES "public"."friend_groups"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_calls_one_live_per_dm" ON "dm_calls" USING btree ("dm_id") WHERE "dm_calls"."status" in ('ringing', 'active');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_calls_dm_id_created_at" ON "dm_calls" USING btree ("dm_id","created_at" DESC NULLS LAST);