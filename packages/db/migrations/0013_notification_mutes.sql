CREATE TABLE IF NOT EXISTS "notification_mutes" (
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"target_id" uuid NOT NULL,
	"mode" text DEFAULT 'all' NOT NULL,
	"until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "notification_mutes_user_id_scope_target_id_pk" PRIMARY KEY("user_id","scope","target_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_mutes" ADD CONSTRAINT "notification_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_mutes_user_id_idx" ON "notification_mutes" USING btree ("user_id");