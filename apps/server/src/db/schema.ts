/**
 * BetterAuth's core Drizzle schema (Postgres). Table + column names match what
 * `betterAuth` + `drizzleAdapter` expect out of the box, so no field mapping is
 * needed. Downstream product tables (billing, subscriptions) will reference
 * `user.id` — this is the anchor the paid-user work hangs off.
 */
import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core"

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

// ── Account-owned remote devices ──────────────────────────────────────────────────────
// Durable ownership lives here. Relay Durable Objects contain only ephemeral
// presence and routing state, so an offline device remains discoverable.
export const ownedDevice = pgTable(
  "owned_device",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    identityFingerprint: text("identity_fingerprint").notNull(),
    displayName: text("display_name").notNull(),
    platform: text("platform_json").notNull(),
    publicKey: text("public_key_json").notNull(),
    encryptionPublicKey: text("encryption_public_key_json"),
    capabilities: text("capabilities_json").notNull(),
    agentVersion: text("agent_version"),
    state: text("state").default("active").notNull(),
    generation: integer("generation").default(1).notNull(),
    enrolledAt: timestamp("enrolled_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("owned_device_user_identity_unique").on(
      table.userId,
      table.identityFingerprint
    )
  ]
)

/**
 * Server-side replay ledger for invisible SSH-delivered enrollment credentials.
 * The signed credential remains outside the database; only its identifier and
 * scope are stored, and consumption is performed in the device upsert transaction.
 */
export const deviceEnrollment = pgTable("device_enrollment", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull(),
  clientInstanceId: text("client_instance_id").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  identityFingerprint: text("identity_fingerprint"),
  createdAt: timestamp("created_at").notNull()
})

// ── Cloudflare-managed environments ────────────────────────────────────────
// Postgres owns durable account/lifecycle metadata. Live container state and
// current authorization stay in the managed-runtime Durable Objects.
export const managedEnvironment = pgTable(
  "managed_environment",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    state: text("state").default("paused").notNull(),
    region: text("region"),
    instanceType: text("instance_type").default("basic").notNull(),
    capabilities: text("capabilities_json").notNull(),
    generation: integer("generation").default(1).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    deletedAt: timestamp("deleted_at")
  },
  (table) => [
    uniqueIndex("managed_environment_user_idempotency_unique").on(
      table.userId,
      table.idempotencyKey
    ),
    index("managed_environment_user_state_updated_idx").on(
      table.userId,
      table.state,
      table.updatedAt,
      table.id
    ),
    check(
      "managed_environment_state_check",
      sql`${table.state} in ('provisioning', 'online', 'sleeping', 'restoring', 'paused', 'failed', 'revoked')`
    ),
    check(
      "managed_environment_instance_type_check",
      sql`${table.instanceType} in ('basic', 'standard-1')`
    ),
    check("managed_environment_generation_check", sql`${table.generation} >= 1`)
  ]
)

export const managedSessionRuntime = pgTable(
  "managed_session_runtime",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => managedEnvironment.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    state: text("state").default("provisioning").notNull(),
    generation: integer("generation").default(1).notNull(),
    sandboxId: text("sandbox_id").notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    headSha: text("head_sha").notNull(),
    branch: text("branch").notNull(),
    lastEventCursor: bigint("last_event_cursor", { mode: "number" }).default(0).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    terminalAt: timestamp("terminal_at")
  },
  (table) => [
    uniqueIndex("managed_runtime_user_session_unique").on(table.userId, table.sessionId),
    uniqueIndex("managed_runtime_user_idempotency_unique").on(
      table.userId,
      table.idempotencyKey
    ),
    index("managed_runtime_user_state_updated_idx").on(
      table.userId,
      table.state,
      table.updatedAt,
      table.id
    ),
    index("managed_runtime_environment_state_idx").on(table.environmentId, table.state),
    check("managed_runtime_generation_check", sql`${table.generation} >= 1`),
    check("managed_runtime_event_cursor_check", sql`${table.lastEventCursor} >= 0`)
  ]
)

export const workspaceCheckpoint = pgTable(
  "workspace_checkpoint",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => managedEnvironment.id, { onDelete: "cascade" }),
    runtimeId: text("runtime_id")
      .notNull()
      .references(() => managedSessionRuntime.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    workspaceDigest: text("workspace_digest").notNull(),
    headSha: text("head_sha").notNull(),
    branch: text("branch").notNull(),
    eventCursor: bigint("event_cursor", { mode: "number" }).default(0).notNull(),
    manifest: text("manifest_json").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull()
  },
  (table) => [
    uniqueIndex("workspace_checkpoint_runtime_digest_unique").on(
      table.runtimeId,
      table.workspaceDigest
    ),
    index("workspace_checkpoint_user_runtime_created_idx").on(
      table.userId,
      table.runtimeId,
      table.createdAt,
      table.id
    ),
    index("workspace_checkpoint_expiry_idx").on(table.expiresAt, table.id),
    check("workspace_checkpoint_size_check", sql`${table.sizeBytes} >= 0`),
    check("workspace_checkpoint_cursor_check", sql`${table.eventCursor} >= 0`)
  ]
)

export const managedUsageReservation = pgTable(
  "managed_usage_reservation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => managedEnvironment.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    runtimeId: text("runtime_id").references(() => managedSessionRuntime.id, {
      onDelete: "set null"
    }),
    state: text("state").default("reserved").notNull(),
    windowStart: timestamp("window_start").notNull(),
    estimatedMicrousd: bigint("estimated_microusd", { mode: "number" }).notNull(),
    settledMicrousd: bigint("settled_microusd", { mode: "number" }),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    expiresAt: timestamp("expires_at").notNull()
  },
  (table) => [
    uniqueIndex("managed_usage_user_idempotency_unique").on(
      table.userId,
      table.idempotencyKey
    ),
    index("managed_usage_user_window_state_idx").on(
      table.userId,
      table.windowStart,
      table.state,
      table.id
    ),
    index("managed_usage_user_session_state_idx").on(
      table.userId,
      table.sessionId,
      table.state,
      table.id
    ),
    index("managed_usage_expiry_state_idx").on(table.expiresAt, table.state, table.id),
    check(
      "managed_usage_state_check",
      sql`${table.state} in ('reserved', 'active', 'settled', 'released', 'expired')`
    ),
    check("managed_usage_estimate_check", sql`${table.estimatedMicrousd} >= 0`),
    check(
      "managed_usage_settled_check",
      sql`${table.settledMicrousd} is null or ${table.settledMicrousd} >= 0`
    )
  ]
)

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
  ownedDevice,
  deviceEnrollment,
  githubUserAuthorization,
  githubInstallation,
  githubCallbackState,
  githubRelayRegistrationOutbox,
  githubSessionRoute,
  githubSessionRouteOutbox
}
