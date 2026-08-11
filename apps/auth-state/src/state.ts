export type CapabilityProvider = "github" | "codex" | "claude"
export type CapabilityUpstream =
  | "github-api"
  | "openai-api"
  | "chatgpt-codex"
  | "anthropic-api"

export interface AuthSession {
  readonly id: string
  readonly expiresAt: number
}

export interface StoredCredential {
  readonly provider: CapabilityProvider
  readonly handle: string
  /** Stable one-way identity used to make repeated capability sync idempotent. */
  readonly fingerprint: string
  readonly authorizationHeaderEncrypted: string
  readonly upstream?: CapabilityUpstream
  readonly accountIdEncrypted?: string
  readonly expiresAt: number
}

export interface AuthStateRecord {
  readonly subject: string
  readonly version: number
  readonly sessions: Readonly<Record<string, AuthSession>>
  readonly credentials: Readonly<Partial<Record<CapabilityProvider, StoredCredential>>>
}

export interface ManagedAuthSnapshot {
  readonly subject: string
  readonly version: number
  readonly issuedAt: number
  readonly expiresAt: number
  readonly capabilities: readonly string[]
  readonly credentialCapabilities: readonly {
    readonly provider: CapabilityProvider
    readonly handle: string
    readonly expiresAt: number
  }[]
}

const MAX_SNAPSHOT_SECONDS = 5 * 60

export const emptyAuthState = (subject: string): AuthStateRecord => ({
  subject,
  version: 1,
  sessions: {},
  credentials: {}
})

export const removeExpired = (state: AuthStateRecord, now: number): AuthStateRecord => {
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).filter(([, session]) => session.expiresAt > now)
  )
  const credentials = Object.fromEntries(
    Object.entries(state.credentials).filter(([, credential]) => credential.expiresAt > now)
  ) as AuthStateRecord["credentials"]
  if (
    Object.keys(sessions).length === Object.keys(state.sessions).length &&
    Object.keys(credentials).length === Object.keys(state.credentials).length
  ) {
    return state
  }
  return { ...state, version: state.version + 1, sessions, credentials }
}

export const snapshotOf = (state: AuthStateRecord, now: number): ManagedAuthSnapshot => {
  const activeSessionExpiries = Object.values(state.sessions)
    .map((session) => session.expiresAt)
    .filter((expiresAt) => expiresAt > now)
  const authenticated = activeSessionExpiries.length > 0
  const credentialCapabilities = authenticated
    ? Object.values(state.credentials)
        .filter((credential): credential is StoredCredential =>
          credential !== undefined && credential.expiresAt > now
        )
        .map(({ provider, handle, expiresAt }) => ({ provider, handle, expiresAt }))
    : []
  return {
    subject: state.subject,
    version: state.version,
    issuedAt: now,
    expiresAt: Math.min(
      now + MAX_SNAPSHOT_SECONDS,
      ...activeSessionExpiries,
      ...credentialCapabilities.map((credential) => credential.expiresAt)
    ),
    capabilities:
      authenticated && credentialCapabilities.some(
        ({ provider }) => provider === "codex" || provider === "claude"
      )
        ? ["managed.session.execute"]
        : [],
    credentialCapabilities
  }
}

export const resolveCredential = (
  state: AuthStateRecord,
  provider: CapabilityProvider,
  handle: string,
  now: number
): StoredCredential | null => {
  if (!Object.values(state.sessions).some((session) => session.expiresAt > now)) return null
  const credential = state.credentials[provider]
  return credential?.handle === handle && credential.expiresAt > now ? credential : null
}
