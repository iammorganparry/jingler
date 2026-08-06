CREATE TABLE "github_session_route" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"relay_session_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"state" text NOT NULL,
	"archived_at" timestamp,
	"unlinked_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "github_session_route_relay_session_id_unique" UNIQUE("relay_session_id")
);
--> statement-breakpoint
CREATE TABLE "github_session_route_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"relay_session_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"desired_state" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp NOT NULL,
	"delivered_at" timestamp,
	"last_error" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_session_route" ADD CONSTRAINT "github_session_route_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_session_route_outbox" ADD CONSTRAINT "github_session_route_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_session_route_user_session_unique" ON "github_session_route" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_session_route_pull_request_unique" ON "github_session_route" USING btree ("installation_id","repository_id","pull_request_number");--> statement-breakpoint
CREATE UNIQUE INDEX "github_session_route_outbox_relay_session_unique" ON "github_session_route_outbox" USING btree ("relay_session_id");