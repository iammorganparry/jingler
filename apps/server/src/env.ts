import { REMOTE_GRANT_MAX_TTL_SECONDS } from "@jingler/core"

/**
 * Central environment access for the auth server. Read once at module load.
 *
 * Dev-friendly defaults keep the server bootable with zero configuration (Docker
 * Postgres + console magic links). Production MUST set the real secrets — the
 * defaults here are intentionally insecure so a misconfigured prod deploy is
 * obvious rather than silently "working".
 */
type Environment = Readonly<Record<string, string | undefined>>

const optional = (environment: Environment, key: string, fallback = ""): string =>
  environment[key]?.trim() || fallback

const positiveNumber = (environment: Environment, key: string, fallback: number): number => {
  const raw = optional(environment, key)
  if (raw === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`)
  return value
}

const secret = (environment: Environment, key: string, developmentFallback: string): string => {
  const value = environment[key]
  if (value) return value
  if (environment.NODE_ENV === "production") {
    throw new Error(`${key} must be set in production`)
  }
  return developmentFallback
}

const enabled = (environment: Environment, key: string, fallback = true): boolean => {
  const value = environment[key]
  if (value === undefined) return fallback
  return value === "1" || value.toLocaleLowerCase("en-US") === "true"
}

const featureConfiguration = (
  environment: Environment,
  feature: string,
  isEnabled: boolean,
  keys: ReadonlyArray<string>
): boolean => {
  const missing = keys.filter((key) => optional(environment, key) === "")
  if (isEnabled && environment.NODE_ENV === "production" && missing.length > 0) {
    throw new Error(`${feature} is enabled but missing ${missing.join(", ")}`)
  }
  return missing.length === 0
}

const isLocalhost = (url: string): boolean => /localhost|127\.0\.0\.1|\[::1\]/.test(url)

const httpUrl = (value: string, key: string, production: boolean): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${key} must be a valid HTTP URL`)
  }
  if (!(url.protocol === "http:" || url.protocol === "https:")) {
    throw new Error(`${key} must be a valid HTTP URL`)
  }
  if (production && url.protocol !== "https:")
    throw new Error(`${key} must use HTTPS in production`)
  return value
}

const validateGitHubSecrets = (environment: Environment): void => {
  if (environment.NODE_ENV !== "production") return
  const keys = [
    "GITHUB_APP_WEBHOOK_SECRET",
    "GITHUB_APP_RELAY_SIGNING_SECRET",
    "GITHUB_APP_TOKEN_ENCRYPTION_KEY"
  ] as const
  const values = keys.map((key) => [key, optional(environment, key)] as const)
  for (const [key, value] of values) {
    if (Buffer.byteLength(value, "utf8") < 32) {
      throw new Error(`${key} must contain at least 32 bytes in production`)
    }
  }
  const previous = optional(environment, "GITHUB_APP_TOKEN_ENCRYPTION_PREVIOUS_KEY")
  if (previous !== "" && Buffer.byteLength(previous, "utf8") < 32) {
    throw new Error(
      "GITHUB_APP_TOKEN_ENCRYPTION_PREVIOUS_KEY must contain at least 32 bytes in production"
    )
  }
  const distinct = [
    ...values,
    ["BETTER_AUTH_SECRET", optional(environment, "BETTER_AUTH_SECRET")] as const,
    ["CRON_SECRET", optional(environment, "CRON_SECRET")] as const,
    ...(previous === ""
      ? []
      : [["GITHUB_APP_TOKEN_ENCRYPTION_PREVIOUS_KEY", previous] as const])
  ]
  for (let left = 0; left < distinct.length; left += 1) {
    for (let right = left + 1; right < distinct.length; right += 1) {
      if (distinct[left]?.[1] === distinct[right]?.[1]) {
        throw new Error(`${distinct[left]?.[0]} and ${distinct[right]?.[0]} must be distinct`)
      }
    }
  }
}

/**
 * A URL with a convenient localhost dev default that is WRONG in production. Like
 * `optional`, but in prod a missing or localhost value is a misconfiguration that
 * must fail loudly — otherwise the app silently talks to localhost (a dead worker,
 * an auth callback pointing at a dev port) with no boot-time signal. `require`
 * lets a URL be prod-mandatory only when the feature using it is on.
 */
const prodUrl = (
  environment: Environment,
  key: string,
  developmentFallback: string,
  { require: isRequired = true }: { require?: boolean } = {}
): string => {
  const raw = optional(environment, key)
  const isProd = environment.NODE_ENV === "production"
  if (raw !== "") {
    if (isProd && isRequired && isLocalhost(raw)) {
      throw new Error(`${key} must not be a localhost URL in production`)
    }
    return raw
  }
  if (isProd && isRequired) throw new Error(`${key} must be set in production`)
  return developmentFallback
}

export const loadEnv = (environment: Environment = process.env) => {
  const nodeEnv = optional(environment, "NODE_ENV", "development")
  const githubAppEnabled = enabled(environment, "GITHUB_APP_ENABLED", false)
  const deviceRelayEnabled = enabled(environment, "DEVICE_RELAY_ENABLED", false)
  const managedEnvironmentsEnabled = enabled(
    environment,
    "MANAGED_ENVIRONMENTS_ENABLED",
    false
  )
  const offloadComputeEnabled = enabled(environment, "OFFLOAD_COMPUTE_ENABLED", false)
  if (offloadComputeEnabled && !managedEnvironmentsEnabled) {
    throw new Error("OFFLOAD_COMPUTE_ENABLED requires MANAGED_ENVIRONMENTS_ENABLED")
  }
  const authSecret = secret(environment, "BETTER_AUTH_SECRET", "dev-insecure-secret-change-me")
  const cronSecret = secret(environment, "CRON_SECRET", "dev-cron-secret-change-me")
  if (nodeEnv === "production" && Buffer.byteLength(cronSecret, "utf8") < 32) {
    throw new Error("CRON_SECRET must contain at least 32 bytes in production")
  }
  const githubAppConfigured = featureConfiguration(environment, "GITHUB_APP", githubAppEnabled, [
    "GITHUB_APP_ID",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_WEBHOOK_SECRET",
    "GITHUB_APP_RELAY_URL",
    "GITHUB_APP_RELAY_SIGNING_SECRET",
    "GITHUB_APP_TOKEN_ENCRYPTION_KEY"
  ])
  const { githubAppId, githubAppRelayUrl } = githubRelayConfiguration()
  const deviceRelayConfigured = featureConfiguration(
    environment,
    "DEVICE_RELAY",
    deviceRelayEnabled,
    ["DEVICE_RELAY_URL", "DEVICE_RELAY_SIGNING_SECRET"]
  )
  const deviceRelayUrl = prodUrl(
    environment,
    "DEVICE_RELAY_URL",
    "http://localhost:9300",
    { require: deviceRelayEnabled }
  )
  validateDeviceRelayConfiguration()
  const deviceRelayGrantTtlSeconds = positiveNumber(
    environment,
    "DEVICE_RELAY_GRANT_TTL_SECONDS",
    300
  )
  if (
    !Number.isSafeInteger(deviceRelayGrantTtlSeconds) ||
    deviceRelayGrantTtlSeconds > REMOTE_GRANT_MAX_TTL_SECONDS
  ) {
    throw new Error(
      `DEVICE_RELAY_GRANT_TTL_SECONDS must be an integer no greater than ${REMOTE_GRANT_MAX_TTL_SECONDS}`
    )
  }
  const deviceBootstrapTtlSeconds = positiveNumber(
    environment,
    "DEVICE_BOOTSTRAP_TTL_SECONDS",
    300
  )
  const managedRuntimeUrl = prodUrl(
    environment,
    "MANAGED_RUNTIME_URL",
    "http://localhost:9400",
    { require: managedEnvironmentsEnabled }
  )
  if (managedEnvironmentsEnabled) {
    httpUrl(managedRuntimeUrl, "MANAGED_RUNTIME_URL", nodeEnv === "production")
  }
  const managedRuntimeServiceSecret = optional(
    environment,
    "MANAGED_RUNTIME_SERVICE_SECRET",
    "dev-managed-runtime-service-secret-change-me"
  )
  const authStateUrl = prodUrl(
    environment,
    "AUTH_STATE_URL",
    "http://localhost:9450",
    { require: managedEnvironmentsEnabled }
  )
  const authStateServiceSecret = optional(
    environment,
    "AUTH_STATE_SERVICE_SECRET",
    managedRuntimeServiceSecret
  )
  const managedMaxConcurrentSessions = positiveNumber(
    environment,
    "MANAGED_MAX_CONCURRENT_SESSIONS",
    1
  )
  const managedMaxActiveSeconds = positiveNumber(
    environment,
    "MANAGED_MAX_ACTIVE_SECONDS",
    7_200
  )
  const managedDailyBudgetMicrousd = positiveNumber(
    environment,
    "MANAGED_DAILY_BUDGET_MICROUSD",
    200_000
  )
  const managedMaxEgressBytes = positiveNumber(
    environment,
    "MANAGED_MAX_EGRESS_BYTES",
    100 * 1024 * 1024
  )
  const managedMaxCheckpointBytes = positiveNumber(
    environment,
    "MANAGED_MAX_CHECKPOINT_BYTES",
    64 * 1024 * 1024
  )
  const managedCheckpointRetentionSeconds = positiveNumber(
    environment,
    "MANAGED_CHECKPOINT_RETENTION_SECONDS",
    7 * 24 * 60 * 60
  )
  if (
    managedEnvironmentsEnabled &&
    nodeEnv === "production" &&
    Buffer.byteLength(managedRuntimeServiceSecret, "utf8") < 32
  ) {
    throw new Error(
      "MANAGED_RUNTIME_SERVICE_SECRET must contain at least 32 bytes when managed environments are enabled"
    )
  }
  if (managedEnvironmentsEnabled) {
    httpUrl(authStateUrl, "AUTH_STATE_URL", nodeEnv === "production")
    if (
      nodeEnv === "production" &&
      Buffer.byteLength(authStateServiceSecret, "utf8") < 32
    ) {
      throw new Error(
        "AUTH_STATE_SERVICE_SECRET must contain at least 32 bytes when managed environments are enabled"
      )
    }
  }
  if (
    !Number.isSafeInteger(deviceBootstrapTtlSeconds) ||
    deviceBootstrapTtlSeconds > 3_600
  ) {
    throw new Error(
      "DEVICE_BOOTSTRAP_TTL_SECONDS must be an integer no greater than 3600"
    )
  }
  return {
    nodeEnv,
    isDev: nodeEnv !== "production",
    port: positiveNumber(environment, "PORT", 9100),
    /** Postgres connection string. Defaults to the local Docker instance (port 5433). */
    databaseUrl: optional(
      environment,
      "DATABASE_URL",
      "postgres://postgres:postgres@localhost:5433/jingler"
    ),
    /** BetterAuth signing secret. MUST be overridden in production. */
    authSecret,
    /** Public base URL the auth server is reachable at (used for OAuth callbacks). */
    authBaseUrl: prodUrl(environment, "BETTER_AUTH_URL", "http://localhost:9100"),
    githubClientId: optional(environment, "GITHUB_CLIENT_ID"),
    githubClientSecret: optional(environment, "GITHUB_CLIENT_SECRET"),
    /** Product GitHub App integration. Deliberately separate from social login above. */
    githubAppEnabled,
    githubAppConfigured,
    githubAppId,
    githubAppClientId: optional(environment, "GITHUB_APP_CLIENT_ID"),
    githubAppClientSecret: optional(environment, "GITHUB_APP_CLIENT_SECRET"),
    githubAppPrivateKey: optional(environment, "GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    githubAppWebhookSecret: optional(environment, "GITHUB_APP_WEBHOOK_SECRET"),
    githubAppRelayUrl,
    /** HMAC key for relay grants and authenticated server-to-relay requests only. */
    githubAppRelaySigningSecret: optional(environment, "GITHUB_APP_RELAY_SIGNING_SECRET"),
    /** Independent root keys for versioned GitHub OAuth-token envelopes. */
    githubAppTokenEncryptionKey: optional(environment, "GITHUB_APP_TOKEN_ENCRYPTION_KEY"),
    githubAppTokenEncryptionPreviousKey: optional(
      environment,
      "GITHUB_APP_TOKEN_ENCRYPTION_PREVIOUS_KEY"
    ),
    /** Dedicated remote-device relay. Disabled until both deployment values are configured. */
    deviceRelayEnabled,
    deviceRelayConfigured,
    deviceRelayUrl,
    deviceRelaySigningSecret: optional(
      environment,
      "DEVICE_RELAY_SIGNING_SECRET",
      "dev-device-relay-signing-secret-change-me"
    ),
    deviceRelayGrantTtlSeconds,
    deviceBootstrapTtlSeconds,
    /** Rollback-safe gate: migrations and runtime deploy before this is enabled. */
    managedEnvironmentsEnabled,
    /** Independent circuit breaker for one-shot automatic compute jobs. */
    offloadComputeEnabled,
    managedRuntimeUrl,
    managedRuntimeServiceSecret,
    authStateUrl,
    authStateServiceSecret,
    managedMaxConcurrentSessions,
    managedMaxActiveSeconds,
    managedDailyBudgetMicrousd,
    managedMaxEgressBytes,
    managedMaxCheckpointBytes,
    managedCheckpointRetentionSeconds,
    googleClientId: optional(environment, "GOOGLE_CLIENT_ID"),
    googleClientSecret: optional(environment, "GOOGLE_CLIENT_SECRET"),
    resendApiKey: optional(environment, "RESEND_API_KEY"),
    emailFrom: optional(environment, "EMAIL_FROM", "Jingler <login@jingler.local>"),
    /** Deep-link the desktop app registers; magic links + OAuth bounce back here. */
    desktopRedirect: optional(environment, "DESKTOP_REDIRECT", "jingler://auth/callback"),
    /** Vercel Cron bearer used only by autonomous maintenance endpoints. */
    cronSecret
  } as const

  function validateDeviceRelayConfiguration() {
    if (deviceRelayConfigured) {
      httpUrl(deviceRelayUrl, "DEVICE_RELAY_URL", nodeEnv === "production")
      const signingSecret = optional(environment, "DEVICE_RELAY_SIGNING_SECRET")
      if (nodeEnv === "production" && Buffer.byteLength(signingSecret, "utf8") < 32) {
        throw new Error("DEVICE_RELAY_SIGNING_SECRET must contain at least 32 bytes in production")
      }
      if (signingSecret === authSecret) {
        throw new Error("DEVICE_RELAY_SIGNING_SECRET and BETTER_AUTH_SECRET must be distinct")
      }
    }
  }

  function githubRelayConfiguration() {
    const githubAppId = optional(environment, "GITHUB_APP_ID")
    const numericGithubAppId = Number(githubAppId)
    if (githubAppConfigured &&
      (!/^\d+$/.test(githubAppId) ||
        !Number.isSafeInteger(numericGithubAppId) ||
        numericGithubAppId <= 0)) {
      throw new Error("GITHUB_APP_ID must be a positive integer")
    }
    const githubAppRelayUrl = prodUrl(environment, "GITHUB_APP_RELAY_URL", "http://localhost:9200", {
      require: githubAppEnabled
    })
    if (githubAppConfigured) {
      httpUrl(githubAppRelayUrl, "GITHUB_APP_RELAY_URL", nodeEnv === "production")
      validateGitHubSecrets(environment)
    }
    return { githubAppId, githubAppRelayUrl }
  }
}

export type Env = ReturnType<typeof loadEnv>

/**
 * Lazily resolve the environment. Building the accessor never touches the
 * environment, so importing this module cannot throw — critical for `next
 * build`, which imports route modules under NODE_ENV=production purely to read
 * their config exports. The first property read validates and memoizes; a
 * missing production secret still throws, now at first use instead of import.
 */
export const createEnv = (environment: Environment = process.env): Env => {
  let resolved: Env | undefined
  const resolve = (): Env => (resolved ??= loadEnv(environment))
  return new Proxy({} as Env, {
    get: (_target, property) => Reflect.get(resolve(), property),
    has: (_target, property) => Reflect.has(resolve(), property),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, property) =>
      Reflect.getOwnPropertyDescriptor(resolve(), property)
  })
}

export const env: Env = createEnv()

/** True when a social provider has both id + secret configured (else we skip it). */
export const hasGithub = (): boolean => Boolean(env.githubClientId && env.githubClientSecret)
export const hasGoogle = (): boolean => Boolean(env.googleClientId && env.googleClientSecret)
