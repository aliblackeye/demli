-- Servers can carry a banner image, the way a user profile already can.
--
-- STRICTLY ADDITIVE: one NULLABLE column. Nothing is dropped, no existing column
-- changes type, nullability or meaning, and there is no backfill — applying this
-- to production data is a no-op for every pre-0022 row. `banner_url IS NULL` is
-- exactly the "this server has no banner" state every existing server is already
-- in, and the sidebar header keeps its current appearance when it is null (the
-- banner is drawn only when a URL is present, so no empty box and no broken
-- <img> ever appears).
--
-- No index: the column is never a lookup key. It is read as part of the group row
-- that is already being selected by primary key or by membership, and it is never
-- filtered or joined on. An index here would cost writes and buy nothing.
--
-- Storage mirrors the profile banner exactly — the same PUBLIC avatar bucket and
-- the same `SUPABASE_AVATAR_BUCKET` gate, keyed `group-banners/<groupId>/<uuid>.<ext>`
-- so no new env var or bucket is introduced, and a CDN never serves a stale image
-- after a change (each upload is a new object).

ALTER TABLE "friend_groups" ADD COLUMN IF NOT EXISTS "banner_url" text;
