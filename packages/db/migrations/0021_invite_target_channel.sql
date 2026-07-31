-- Invites can point at a CHANNEL, not just a server.
--
-- STRICTLY ADDITIVE: one NULLABLE column plus its lookup index. No existing
-- column changes type, nullability or meaning, so applying this to production
-- data is a no-op for every pre-0021 row — `target_channel_id IS NULL` is
-- exactly the "this invite targets the server" state every existing invite is
-- already in, and the create/preview/redeem paths keep their current behavior
-- when it is null.
--
-- Why ON DELETE SET NULL and not CASCADE: an invite link lives OUTSIDE the app
-- (pasted into a chat, sent over WhatsApp, pinned in a message). Deleting the
-- channel it pointed at must not silently revoke a link people already hold —
-- it only removes the destination, and the link degrades to a plain server
-- invite. Cascade would have made "tidy up a channel" mean "break every invite
-- anyone shared", which is the kind of invisible data loss §35 forbids.
--
-- The link FORMAT is unchanged: still one deep-link shape (…/invite/<code>).
-- The target rides on the row, so the client never has to learn a second URL.

ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "target_channel_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invites" ADD CONSTRAINT "invites_target_channel_id_channels_id_fk" FOREIGN KEY ("target_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Partial: indexes only the targeted invites, not the 99% that target nothing.
-- Without it every channel DELETE seq-scans `invites` to run the SET NULL.
CREATE INDEX IF NOT EXISTS "invites_target_channel_id_idx" ON "invites" USING btree ("target_channel_id") WHERE "target_channel_id" IS NOT NULL;
