CREATE TABLE "device_enrollment" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"identity_fingerprint" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owned_device" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"identity_fingerprint" text NOT NULL,
	"display_name" text NOT NULL,
	"platform_json" text NOT NULL,
	"public_key_json" text NOT NULL,
	"encryption_public_key_json" text,
	"capabilities_json" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"enrolled_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_enrollment" ADD CONSTRAINT "device_enrollment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_device" ADD CONSTRAINT "owned_device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owned_device_user_identity_unique" ON "owned_device" USING btree ("user_id","identity_fingerprint");