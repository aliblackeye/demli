-- Member context menu — private notes, the two kinds of nickname, timeout, ignore.
--
-- STRICTLY ADDITIVE: three new tables plus three NULLABLE columns on existing
-- ones. No existing column changes type, nullability or meaning, so applying this
-- to production data is a no-op for every pre-0020 row — a member with no
-- nickname reads as having none, and `timed_out_until IS NULL` is exactly the
-- "not timed out" state every existing member is already in.
--
-- `moderation_actions.action` gains two values ("timeout", "timeout_remove")
-- with NO SQL at all: the column is plain `text` with a TYPE-level enum, which is
-- precisely the flexibility migration 0019 chose it for.
--
-- Why user_notes and user_nicknames are two tables and not one (see ADR 0019):
-- they share a key but not a blast radius. A nickname is read by many render
-- paths; a note must be read by exactly one endpoint. Separate tables make that
-- second rule mechanically checkable instead of a convention every future join
-- has to remember.

CREATE TABLE IF NOT EXISTS "user_notes" (
	"viewer_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_notes_viewer_id_target_id_pk" PRIMARY KEY("viewer_id","target_id"),
	CONSTRAINT "user_notes_no_self" CHECK ("user_notes"."viewer_id" <> "user_notes"."target_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_nicknames" (
	"viewer_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"nickname" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_nicknames_viewer_id_target_id_pk" PRIMARY KEY("viewer_id","target_id"),
	CONSTRAINT "user_nicknames_no_self" CHECK ("user_nicknames"."viewer_id" <> "user_nicknames"."target_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_ignores" (
	"ignorer_id" uuid NOT NULL,
	"ignored_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ignores_ignorer_id_ignored_id_pk" PRIMARY KEY("ignorer_id","ignored_id"),
	CONSTRAINT "user_ignores_no_self" CHECK ("user_ignores"."ignorer_id" <> "user_ignores"."ignored_id")
);
--> statement-breakpoint
ALTER TABLE "friend_group_members" ADD COLUMN IF NOT EXISTS "nickname" text;--> statement-breakpoint
ALTER TABLE "friend_group_members" ADD COLUMN IF NOT EXISTS "timed_out_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_nicknames" ADD CONSTRAINT "user_nicknames_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_nicknames" ADD CONSTRAINT "user_nicknames_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_ignores" ADD CONSTRAINT "user_ignores_ignorer_id_users_id_fk" FOREIGN KEY ("ignorer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_ignores" ADD CONSTRAINT "user_ignores_ignored_id_users_id_fk" FOREIGN KEY ("ignored_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
