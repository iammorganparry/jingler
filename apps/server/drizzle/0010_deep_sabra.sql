ALTER TABLE "managed_usage_reservation" ADD COLUMN "session_id" text;--> statement-breakpoint
UPDATE "managed_usage_reservation"
SET "session_id" = split_part("idempotency_key", ':', 2);--> statement-breakpoint
ALTER TABLE "managed_usage_reservation" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "managed_usage_user_session_state_idx" ON "managed_usage_reservation" USING btree ("user_id","session_id","state","id");
