-- 0012 message search (ADR 0011 §5). Additive + non-breaking, safe on the live
-- database: one STORED generated column on `messages` (`search_vector`) derived
-- from `content` with the language-agnostic `simple` full-text config — no
-- stemming, because Postgres ships no Turkish dictionary and channels carry mixed
-- TR/EN text. `to_tsvector('simple', content)` is IMMUTABLE (the config is a
-- constant), so it is a legal generation expression. Every existing row
-- auto-populates as the column materializes; there is no backfill and `content`
-- is never written. A GIN index over the vector makes
-- `search_vector @@ websearch_to_tsquery('simple', q)` an index scan.
--
-- NOTE for the prod apply (Director): adding a STORED generated column rewrites
-- the table under ACCESS EXCLUSIVE for the duration — trivial at friend-group
-- scale, but schedule it like any rewrite on a large table.
--
-- Each statement guards itself (IF NOT EXISTS) so a partial re-apply is safe.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_search_vector_idx" ON "messages" USING gin ("search_vector");
