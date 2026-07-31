ALTER TABLE "channels" ADD COLUMN "slowmode_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "audio_bitrate_kbps" integer;--> statement-breakpoint
ALTER TABLE "friend_groups" ADD COLUMN "system_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "friend_groups" ADD CONSTRAINT "friend_groups_system_channel_id_channels_id_fk" FOREIGN KEY ("system_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
