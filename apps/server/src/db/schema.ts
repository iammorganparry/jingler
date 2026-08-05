/**
 * BetterAuth's core Drizzle schema (Postgres). Table + column names match what
 * `betterAuth` + `drizzleAdapter` expect out of the box, so no field mapping is
 * needed. Downstream product tables (billing, subscriptions) will reference
 * `user.id` — this is the anchor the paid-user work hangs off.
 */
import { sql } from "drizzle-orm"
import { boolean, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => new Date())
    .notNull()
})

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // The org the session is currently acting in (BetterAuth organization plugin).
  activeOrganizationId: text("active_organization_id")
})

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull()
})

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date())
})

// ── Organization plugin (teams) ──────────────────────────────────────────────
// Table + column names match what the BetterAuth `organization` plugin expects.
// Teams/dynamic-roles are disabled, so only these three tables are needed.

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").notNull()
})

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").default("member").notNull(),
  createdAt: timestamp("created_at").notNull()
})

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").default("pending").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
})

// ── Personal Access Tokens (headless team-memory MCP auth) ───────────────────
// Long-lived, org-scoped bearer credentials that let an EXTERNAL agent call the
// hosted team-memory MCP endpoint without the desktop app minting a short-lived
// grant. Only the SHA-256 hash of the token is ever stored; the plaintext is
// shown once at creation and never persisted or logged. Revocation, expiry and
// the paid-membership gate are re-checked per request at verification time, so a
// token never outlives the membership that authorised it.
export const personalAccessToken = pgTable("personal_access_token", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  // Human-readable label ("CI runner", "my laptop") — never security-bearing.
  name: text("name").notNull(),
  // SHA-256 hex of the full `jmem_…` token. Unique so a lookup is by hash alone.
  hashedToken: text("hashed_token").notNull().unique(),
  // MemoryOrganizationRole the token was minted at; privileges are re-derived and
  // intersected with the live membership on every request.
  role: text("role").notNull(),
  createdAt: timestamp("created_at")
    .$defaultFn(() => new Date())
    .notNull(),
  // NULL = never expires.
  expiresAt: timestamp("expires_at"),
  // NULL = active; a timestamp = revoked, permanently rejected thereafter.
  revokedAt: timestamp("revoked_at"),
  lastUsedAt: timestamp("last_used_at")
})

// ── GitHub App product connection ───────────────────────────────────────────
// BetterAuth's `account` rows above remain sign-in identities. These tables own
// the independently revocable GitHub App authorization and installations.

export const githubUserAuthorization = pgTable("github_user_authorization", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  githubUserId: text("github_user_id").notNull(),
  githubLogin: text("github_login").notNull(),
  githubName: text("github_name"),
  githubAvatarUrl: text("github_avatar_url"),
  // AES-256-GCM envelopes. Plaintext tokens never enter another table.
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => new Date())
    .notNull(),
  lastRefreshedAt: timestamp("last_refreshed_at").notNull()
})

export const githubInstallation = pgTable(
  "github_installation",
  {
    id: text("id").primaryKey(),
    authorizationId: text("authorization_id")
      .notNull()
      .references(() => githubUserAuthorization.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    accountId: text("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    accountAvatarUrl: text("account_avatar_url"),
    repositorySelection: text("repository_selection").notNull(),
    // GitHub adds permission names over time; JSON text avoids a migration for each one.
    permissions: text("permissions").notNull(),
    suspendedAt: timestamp("suspended_at"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull()
  },
  (table) => [
    uniqueIndex("github_installation_authorization_installation_unique").on(
      table.authorizationId,
      table.installationId
    )
  ]
)

export const githubCallbackState = pgTable("github_callback_state", {
  id: text("id").primaryKey(),
  // Only a SHA-256 digest is persisted. The browser receives the opaque state.
  stateHash: text("state_hash").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeVerifierEncrypted: text("code_verifier_encrypted").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => new Date())
    .notNull()
})

/**
 * Durable desired-state handoff to the relay. Rows deliberately outlive the
 * GitHub authorization they revoke, so local disconnect never depends on relay
 * availability. The unique target makes every delivery idempotent.
 */
export const githubRelayRegistrationOutbox = pgTable(
  "github_relay_registration_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    desiredState: text("desired_state").notNull(),
    generation: integer("generation").default(1).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at").notNull(),
    deliveredAt: timestamp("delivered_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull()
  },
  (table) => [
    uniqueIndex("github_relay_outbox_user_installation_unique").on(
      table.userId,
      table.installationId
    )
  ]
)

/**
 * Authenticated ownership of a local Jingler session's linked pull request.
 * `sessionId` is visible only to its owning user. The relay sees only the
 * independently generated `relaySessionId`, which is also the Durable Object
 * identity and therefore must never be accepted from an unverified webhook.
 */
export const githubSessionRoute = pgTable(
  "github_session_route",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    relaySessionId: text("relay_session_id").notNull().unique(),
    installationId: text("installation_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    state: text("state").notNull(),
    generation: integer("generation").default(1).notNull(),
    archivedAt: timestamp("archived_at"),
    unlinkedAt: timestamp("unlinked_at"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull()
  },
  (table) => [
    uniqueIndex("github_session_route_user_session_unique").on(table.userId, table.sessionId),
    uniqueIndex("github_session_route_pull_request_unique").on(
      table.installationId,
      table.repositoryId,
      table.pullRequestNumber
    ).where(sql`${table.state} <> 'removed'`)
  ]
)

/**
 * Latest desired session-route state waiting to be handed to the relay
 * Workflow. Snapshot fields deliberately survive route changes and retries.
 */
export const githubSessionRouteOutbox = pgTable(
  "github_session_route_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    relaySessionId: text("relay_session_id").notNull(),
    installationId: text("installation_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    desiredState: text("desired_state").notNull(),
    generation: integer("generation").default(1).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at").notNull(),
    deliveredAt: timestamp("delivered_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull()
  },
  (table) => [
    uniqueIndex("github_session_route_outbox_session_generation_unique").on(
      table.relaySessionId,
      table.generation
    )
  ]
)

export const schema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  personalAccessToken,
  githubUserAuthorization,
  githubInstallation,
  githubCallbackState,
  githubRelayRegistrationOutbox,
  githubSessionRoute,
  githubSessionRouteOutbox
}
