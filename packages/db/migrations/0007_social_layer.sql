-- M13 social layer (ADR 0010, W1b). The Drizzle postgres-js migrator wraps ALL
-- pending migrations in ONE transaction. Postgres 16 permits `ALTER TYPE ... ADD
-- VALUE` inside a transaction but FORBIDS using that value before the txn commits
-- ("unsafe use of new value"). Therefore nothing in this migration references the
-- 'dm' literal: the DM uniqueness index keys on `dm_key IS NOT NULL` (dm_key is
-- set iff kind='dm'), an equivalent predicate that never touches the enum value.
-- See .claude/reports/social-db-w1b.md for the full rationale.
CREATE TYPE "public"."friendship_status" AS ENUM('pending', 'accepted');--> statement-breakpoint
ALTER TYPE "public"."friend_group_kind" ADD VALUE IF NOT EXISTS 'dm';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "friendships" (
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"status" "friendship_status" NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "friendships_user_a_user_b_pk" PRIMARY KEY("user_a","user_b"),
	CONSTRAINT "friendships_canonical_order" CHECK ("friendships"."user_a" < "friendships"."user_b")
);
--> statement-breakpoint
ALTER TABLE "friend_group_members" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "friend_groups" ADD COLUMN "dm_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" text;--> statement-breakpoint
-- friend_code is 3-phase so a non-empty (seeded) users table survives: add
-- nullable, backfill a unique base32 code per existing row, then constrain.
ALTER TABLE "users" ADD COLUMN "friend_code" text;--> statement-breakpoint
DO $$
DECLARE
	r record;
	new_code text;
	alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- invite alphabet, no 0/O/1/I/L
	i integer;
BEGIN
	FOR r IN SELECT id FROM users WHERE friend_code IS NULL LOOP
		LOOP
			new_code := '';
			FOR i IN 1..8 LOOP
				new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
			END LOOP;
			EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE friend_code = new_code);
		END LOOP;
		UPDATE users SET friend_code = new_code WHERE id = r.id;
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "friend_code" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_a_users_id_fk" FOREIGN KEY ("user_a") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_b_users_id_fk" FOREIGN KEY ("user_b") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "friendships_user_b_idx" ON "friendships" USING btree ("user_b");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "friend_groups_dm_key_unique" ON "friend_groups" USING btree ("dm_key") WHERE "friend_groups"."dm_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_friend_code_unique" ON "users" USING btree ("friend_code");
