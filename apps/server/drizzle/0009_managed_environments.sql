CREATE TABLE "managed_environment" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"state" text DEFAULT 'paused' NOT NULL,
	"region" text,
	"instance_type" text DEFAULT 'basic' NOT NULL,
	"capabilities_json" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "managed_environment_state_check" CHECK ("managed_environment"."state" in ('provisioning', 'online', 'sleeping', 'restoring', 'paused', 'failed', 'revoked')),
	CONSTRAINT "managed_environment_instance_type_check" CHECK ("managed_environment"."instance_type" in ('basic', 'standard-1')),
	CONSTRAINT "managed_environment_generation_check" CHECK ("managed_environment"."generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "managed_session_runtime" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"session_id" text NOT NULL,
	"state" text DEFAULT 'provisioning' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"sandbox_id" text NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"head_sha" text NOT NULL,
	"branch" text NOT NULL,
	"last_event_cursor" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"terminal_at" timestamp,
	CONSTRAINT "managed_runtime_generation_check" CHECK ("managed_session_runtime"."generation" >= 1),
	CONSTRAINT "managed_runtime_event_cursor_check" CHECK ("managed_session_runtime"."last_event_cursor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "managed_usage_reservation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"runtime_id" text,
	"state" text DEFAULT 'reserved' NOT NULL,
	"window_start" timestamp NOT NULL,
	"estimated_microusd" bigint NOT NULL,
	"settled_microusd" bigint,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "managed_usage_state_check" CHECK ("managed_usage_reservation"."state" in ('reserved', 'active', 'settled', 'released', 'expired')),
	CONSTRAINT "managed_usage_estimate_check" CHECK ("managed_usage_reservation"."estimated_microusd" >= 0),
	CONSTRAINT "managed_usage_settled_check" CHECK ("managed_usage_reservation"."settled_microusd" is null or "managed_usage_reservation"."settled_microusd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_checkpoint" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"object_key" text NOT NULL,
	"workspace_digest" text NOT NULL,
	"head_sha" text NOT NULL,
	"branch" text NOT NULL,
	"event_cursor" bigint DEFAULT 0 NOT NULL,
	"manifest_json" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "workspace_checkpoint_size_check" CHECK ("workspace_checkpoint"."size_bytes" >= 0),
	CONSTRAINT "workspace_checkpoint_cursor_check" CHECK ("workspace_checkpoint"."event_cursor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "managed_environment" ADD CONSTRAINT "managed_environment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_session_runtime" ADD CONSTRAINT "managed_session_runtime_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_session_runtime" ADD CONSTRAINT "managed_session_runtime_environment_id_managed_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."managed_environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_usage_reservation" ADD CONSTRAINT "managed_usage_reservation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_usage_reservation" ADD CONSTRAINT "managed_usage_reservation_environment_id_managed_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."managed_environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_usage_reservation" ADD CONSTRAINT "managed_usage_reservation_runtime_id_managed_session_runtime_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."managed_session_runtime"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_checkpoint" ADD CONSTRAINT "workspace_checkpoint_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_checkpoint" ADD CONSTRAINT "workspace_checkpoint_environment_id_managed_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."managed_environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_checkpoint" ADD CONSTRAINT "workspace_checkpoint_runtime_id_managed_session_runtime_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."managed_session_runtime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_environment_user_idempotency_unique" ON "managed_environment" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "managed_environment_user_state_updated_idx" ON "managed_environment" USING btree ("user_id","state","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_runtime_user_session_unique" ON "managed_session_runtime" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_runtime_user_idempotency_unique" ON "managed_session_runtime" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "managed_runtime_user_state_updated_idx" ON "managed_session_runtime" USING btree ("user_id","state","updated_at","id");--> statement-breakpoint
CREATE INDEX "managed_runtime_environment_state_idx" ON "managed_session_runtime" USING btree ("environment_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_usage_user_idempotency_unique" ON "managed_usage_reservation" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "managed_usage_user_window_state_idx" ON "managed_usage_reservation" USING btree ("user_id","window_start","state","id");--> statement-breakpoint
CREATE INDEX "managed_usage_expiry_state_idx" ON "managed_usage_reservation" USING btree ("expires_at","state","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_checkpoint_runtime_digest_unique" ON "workspace_checkpoint" USING btree ("runtime_id","workspace_digest");--> statement-breakpoint
CREATE INDEX "workspace_checkpoint_user_runtime_created_idx" ON "workspace_checkpoint" USING btree ("user_id","runtime_id","created_at","id");--> statement-breakpoint
CREATE INDEX "workspace_checkpoint_expiry_idx" ON "workspace_checkpoint" USING btree ("expires_at","id");