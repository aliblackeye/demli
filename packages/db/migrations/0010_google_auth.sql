-- 0010 Google OAuth groundwork. Additive + non-breaking, safe to run on the
-- live database: password_hash becomes NULLABLE (existing rows keep their hash),
-- and two nullable identity columns are added. Every statement guards itself so
-- a partial/re-run apply is safe (the migrator wraps all pending migrations in
-- one transaction). See .claude/reports/auth-google-backend.md.
--
-- DROP NOT NULL is a no-op when the column is already nullable, so it is
-- inherently idempotent. ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT
-- EXISTS make the rest re-runnable. NULLs are distinct under a unique index, so
-- the unique constraints never fire on the many rows that leave email/google_sub
-- unset; `lower(email)` makes the email constraint case-insensitive.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_sub" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_google_sub_unique" ON "users" USING btree ("google_sub");
