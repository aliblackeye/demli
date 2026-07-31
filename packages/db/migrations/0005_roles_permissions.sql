CREATE TYPE "public"."invite_policy" AS ENUM('members', 'roles');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"permissions" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_id_group_id_unique" UNIQUE("id","group_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_roles" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_roles_role_id_user_id_pk" PRIMARY KEY("role_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_role_access" (
	"channel_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "channel_role_access_channel_id_role_id_pk" PRIMARY KEY("channel_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "friend_groups" ADD COLUMN "invite_policy" "invite_policy" DEFAULT 'members' NOT NULL;--> statement-breakpoint
-- Composite-FK target on channels must exist BEFORE the channel_role_access FK below.
ALTER TABLE "channels" ADD CONSTRAINT "channels_id_group_id_unique" UNIQUE("id","group_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roles" ADD CONSTRAINT "roles_group_id_friend_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."friend_groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_group_user_fk" FOREIGN KEY ("group_id","user_id") REFERENCES "public"."friend_group_members"("group_id","user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_role_group_fk" FOREIGN KEY ("role_id","group_id") REFERENCES "public"."roles"("id","group_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_role_access" ADD CONSTRAINT "channel_role_access_channel_group_fk" FOREIGN KEY ("channel_id","group_id") REFERENCES "public"."channels"("id","group_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_role_access" ADD CONSTRAINT "channel_role_access_role_group_fk" FOREIGN KEY ("role_id","group_id") REFERENCES "public"."roles"("id","group_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roles_group_id_idx" ON "roles" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_roles_group_user_idx" ON "member_roles" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_role_access_role_idx" ON "channel_role_access" USING btree ("role_id");
