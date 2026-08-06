CREATE TABLE "github_callback_state" (
	"id" text PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_verifier_encrypted" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "github_callback_state_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "github_installation" (
	"id" text PRIMARY KEY NOT NULL,
	"authorization_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"account_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"account_avatar_url" text,
	"repository_selection" text NOT NULL,
	"permissions" text NOT NULL,
	"suspended_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_user_authorization" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"github_user_id" text NOT NULL,
	"github_login" text NOT NULL,
	"github_name" text,
	"github_avatar_url" text,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"last_refreshed_at" timestamp NOT NULL,
	CONSTRAINT "github_user_authorization_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "github_callback_state" ADD CONSTRAINT "github_callback_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation" ADD CONSTRAINT "github_installation_authorization_id_github_user_authorization_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."github_user_authorization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_user_authorization" ADD CONSTRAINT "github_user_authorization_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_installation_authorization_installation_unique" ON "github_installation" USING btree ("authorization_id","installation_id");