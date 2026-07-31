CREATE TYPE "public"."friend_group_kind" AS ENUM('server', 'group');--> statement-breakpoint
ALTER TABLE "friend_groups" ADD COLUMN "kind" "friend_group_kind" DEFAULT 'server' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "friend_groups_kind_idx" ON "friend_groups" USING btree ("kind");