CREATE TABLE "github_relay_registration_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"desired_state" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp NOT NULL,
	"delivered_at" timestamp,
	"last_error" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_relay_registration_outbox" ADD CONSTRAINT "github_relay_registration_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "github_relay_outbox_user_installation_unique" ON "github_relay_registration_outbox" USING btree ("user_id","installation_id");
--> statement-breakpoint
INSERT INTO "github_relay_registration_outbox" (
	"id", "user_id", "installation_id", "desired_state", "attempt_count",
	"next_attempt_at", "created_at", "updated_at"
)
SELECT
	md5(a."user_id" || ':' || i."installation_id"),
	a."user_id",
	i."installation_id",
	CASE WHEN i."suspended_at" IS NULL THEN 'active' ELSE 'suspended' END,
	0,
	CURRENT_TIMESTAMP,
	CURRENT_TIMESTAMP,
	CURRENT_TIMESTAMP
FROM "github_installation" i
JOIN "github_user_authorization" a ON a."id" = i."authorization_id"
ON CONFLICT ("user_id", "installation_id") DO NOTHING;
