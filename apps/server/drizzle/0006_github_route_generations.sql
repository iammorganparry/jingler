DROP INDEX "github_session_route_outbox_relay_session_unique";--> statement-breakpoint
DROP INDEX "github_session_route_pull_request_unique";--> statement-breakpoint
ALTER TABLE "github_relay_registration_outbox" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "github_session_route" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "github_session_route_outbox" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "github_session_route_outbox_session_generation_unique" ON "github_session_route_outbox" USING btree ("relay_session_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "github_session_route_pull_request_unique" ON "github_session_route" USING btree ("installation_id","repository_id","pull_request_number") WHERE "github_session_route"."state" <> 'removed';