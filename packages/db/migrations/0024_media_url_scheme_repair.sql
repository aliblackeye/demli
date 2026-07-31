-- Repair stored avatar/banner/icon URLs whose SCHEME could never have been legal.
--
-- WHY THIS EXISTS. Until this change the API validated these three columns with
-- zod's `.url()`, which asks one question — does `new URL(value)` succeed — and
-- that succeeds for `javascript:alert(1)`, `data:text/html;base64,…`,
-- `file:///etc/passwd` and anything else with a colon in it. The routes now use
-- `mediaUrlField` (absolute http(s) only), so nothing of that shape can be
-- WRITTEN any more. This migration is about what was already written: the values
-- persisted while the weak rule was in force, which are served to every client
-- that can see the user or the server and would keep being served forever.
--
-- WHAT IT TOUCHES. Only rows whose value does not begin with `http://` or
-- `https://` — i.e. exactly the values the new validator would refuse and that
-- no legitimate flow has ever produced. Every URL this product writes itself
-- (the public Supabase bucket for avatars/banners/group banners, and a Google
-- profile photo on OAuth sign-in) is `https://`, so a correct row cannot match
-- the predicate. NULL stays NULL; `IS NOT NULL` keeps those rows out of the
-- write entirely.
--
-- WHY NULL RATHER THAN A REWRITE. There is no safe repair for `javascript:…` —
-- the value carries no image, so the only honest states are "an image" and "no
-- image". NULL is already a first-class, fully-rendered state on all three
-- columns (no avatar → the initials fallback; no banner → the header renders as
-- it always has), so a repaired row lands in a shape every client has handled
-- since those columns existed. Nothing is dropped, no column changes type or
-- nullability, and re-running this is a no-op: after the first pass no row
-- matches the predicate.
--
-- `~*` and not `LIKE`: the scheme is case-insensitive per RFC 3986, so `HTTPS://`
-- is a legitimate value and must not be nulled. The anchor is what makes this a
-- SCHEME test rather than a substring test — `javascript:/*https://*/alert(1)`
-- contains `https://` and must still be caught.

UPDATE "users"
SET "avatar_url" = NULL
WHERE "avatar_url" IS NOT NULL
  AND "avatar_url" !~* '^https?://';

UPDATE "users"
SET "banner_url" = NULL
WHERE "banner_url" IS NOT NULL
  AND "banner_url" !~* '^https?://';

UPDATE "friend_groups"
SET "icon_url" = NULL
WHERE "icon_url" IS NOT NULL
  AND "icon_url" !~* '^https?://';

UPDATE "friend_groups"
SET "banner_url" = NULL
WHERE "banner_url" IS NOT NULL
  AND "banner_url" !~* '^https?://';
