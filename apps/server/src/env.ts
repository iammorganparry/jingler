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

export const loadEnv = (environment: Environment = process.env) => {
  const nodeEnv = optional(environment, "NODE_ENV", "development")
  return {
  nodeEnv,
  isDev: nodeEnv !== "production",
  port: positiveNumber(environment, "PORT", 9100),
  /** Postgres connection string. Defaults to the local Docker instance (port 5433). */
  databaseUrl: optional(environment, "DATABASE_URL", "postgres://postgres:postgres@localhost:5433/jingler"),
  /** BetterAuth signing secret. MUST be overridden in production. */
  authSecret: secret(environment, "BETTER_AUTH_SECRET", "dev-insecure-secret-change-me"),
  /** Public base URL the auth server is reachable at (used for OAuth callbacks). */
  authBaseUrl: optional(environment, "BETTER_AUTH_URL", "http://localhost:9100"),
  githubClientId: optional(environment, "GITHUB_CLIENT_ID"),
  githubClientSecret: optional(environment, "GITHUB_CLIENT_SECRET"),
  googleClientId: optional(environment, "GOOGLE_CLIENT_ID"),
  googleClientSecret: optional(environment, "GOOGLE_CLIENT_SECRET"),
  resendApiKey: optional(environment, "RESEND_API_KEY"),
  emailFrom: optional(environment, "EMAIL_FROM", "Jingler <login@jingler.local>"),
  /** Global paid-team rollout/circuit-breaker. Disabling it never mutates the vault. */
  memoryEnabled: enabled(environment, "MEMORY_ENABLED"),
  /** HMAC key for short-lived team-memory grants. Keep distinct from BetterAuth. */
  memoryGrantSecret: secret(environment, "MEMORY_GRANT_SECRET", "dev-memory-grant-secret-change-me"),
  memoryGrantAudience: optional(environment, "MEMORY_GRANT_AUDIENCE", "jingler-memory-mcp"),
  memoryGrantTtlSeconds: positiveNumber(environment, "MEMORY_GRANT_TTL_SECONDS", 3600),
  /** Private Cloudflare Worker origin and its rotating Next.js service credential. */
  memoryWorkerUrl: optional(environment, "MEMORY_WORKER_URL", "http://localhost:8787"),
  memoryWorkerServiceSecret: secret(
    environment,
    "MEMORY_WORKER_SERVICE_SECRET",
    "dev-memory-worker-secret-change-me"
  ),
  memoryRequestTimeoutMs: positiveNumber(environment, "MEMORY_REQUEST_TIMEOUT_MS", 5000),
  /** Deep-link the desktop app registers; magic links + OAuth bounce back here. */
  desktopRedirect: optional(environment, "DESKTOP_REDIRECT", "jingler://auth/callback")
} as const
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
