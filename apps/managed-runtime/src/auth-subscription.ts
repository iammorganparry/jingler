const MAX_CAPABILITIES = 32
const MAX_ACTIVE_SESSIONS = 1

export interface ManagedAuthSnapshot {
  readonly subject: string
  readonly version: number
  readonly issuedAt: number
  readonly expiresAt: number
  readonly capabilities: readonly string[]
  readonly credentialCapabilities: readonly {
    readonly provider: "github" | "codex"
    readonly handle: string
    readonly expiresAt: number
  }[]
}

export interface ManagedAuthSubscription {
  readonly leaseExpiresAt: number
}

export interface ManagedAuthState {
  readonly snapshot: ManagedAuthSnapshot | null
  readonly subscription: ManagedAuthSubscription | null
  readonly activeSessionIds: readonly string[]
}

export type AuthorizationDecision =
  | { readonly admitted: true; readonly authStateVersion: number }
  | {
      readonly admitted: false
      readonly reason: "auth-unavailable" | "auth-stale" | "capability-missing"
    }

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

export const decodeManagedAuthSnapshot = (
  value: unknown
): ManagedAuthSnapshot | null => {
  if (typeof value !== "object" || value === null) return null
  const candidate = Object.fromEntries(Object.entries(value))
  if (
    !isNonEmptyString(candidate.subject) ||
    !isPositiveInteger(candidate.version) ||
    !isPositiveInteger(candidate.issuedAt) ||
    !isPositiveInteger(candidate.expiresAt) ||
    !Array.isArray(candidate.capabilities) ||
    candidate.capabilities.length > MAX_CAPABILITIES ||
    !candidate.capabilities.every(isNonEmptyString)
  ) {
    return null
  }
  const credentialCapabilities = candidate.credentialCapabilities ?? []
  if (
    !Array.isArray(credentialCapabilities) ||
    credentialCapabilities.length > 8 ||
    !credentialCapabilities.every((capability) => {
      const fields =
        typeof capability === "object" && capability !== null
          ? Object.fromEntries(Object.entries(capability))
          : null
      return (
        (fields?.provider === "github" || fields?.provider === "codex") &&
        isNonEmptyString(fields.handle) &&
        isPositiveInteger(fields.expiresAt)
      )
    })
  ) {
    return null
  }
  return {
    subject: candidate.subject,
    version: candidate.version,
    issuedAt: candidate.issuedAt,
    expiresAt: candidate.expiresAt,
    capabilities: candidate.capabilities,
    credentialCapabilities
  }
}

export const emptyManagedAuthState = (): ManagedAuthState => ({
  snapshot: null,
  subscription: null,
  activeSessionIds: []
})

/** Pure coordinator state used by the Durable Object and deterministic tests. */
export class ManagedAuthSubscriptionLedger {
  readonly #subject: string
  #state: ManagedAuthState

  constructor(subject: string, restored = emptyManagedAuthState()) {
    this.#subject = subject
    this.#state = restored
  }

  snapshot(): ManagedAuthState {
    return this.#state
  }

  needsSubscription(now: number): boolean {
    return (
      this.#state.subscription === null ||
      this.#state.subscription.leaseExpiresAt <= now ||
      this.#state.snapshot === null ||
      this.#state.snapshot.expiresAt <= now
    )
  }

  registerSession(sessionId: string, now: number): { subscribe: boolean } {
    if (!this.#state.activeSessionIds.includes(sessionId)) {
      if (this.#state.activeSessionIds.length >= MAX_ACTIVE_SESSIONS) {
        throw new Error("Managed session concurrency exceeded")
      }
      this.#state = {
        ...this.#state,
        activeSessionIds: [...this.#state.activeSessionIds, sessionId]
      }
    }
    return { subscribe: this.needsSubscription(now) }
  }

  unregisterSession(sessionId: string): void {
    this.#state = {
      ...this.#state,
      activeSessionIds: this.#state.activeSessionIds.filter(
        (candidate) => candidate !== sessionId
      )
    }
  }

  apply(
    snapshot: ManagedAuthSnapshot,
    subscription: ManagedAuthSubscription
  ): boolean {
    if (snapshot.subject !== this.#subject) return false
    if (
      this.#state.snapshot !== null &&
      snapshot.version < this.#state.snapshot.version
    ) {
      return false
    }
    this.#state = { ...this.#state, snapshot, subscription }
    return true
  }

  disconnect(): void {
    this.#state = { ...this.#state, snapshot: null, subscription: null }
  }

  authorize(capability: string, now: number): AuthorizationDecision {
    if (this.#state.snapshot === null || this.#state.subscription === null) {
      return { admitted: false, reason: "auth-unavailable" }
    }
    if (this.needsSubscription(now)) {
      return { admitted: false, reason: "auth-stale" }
    }
    if (!this.#state.snapshot.capabilities.includes(capability)) {
      return { admitted: false, reason: "capability-missing" }
    }
    return {
      admitted: true,
      authStateVersion: this.#state.snapshot.version
    }
  }

  credentialHandle(
    provider: "github" | "codex",
    now: number
  ): string | null {
    if (this.needsSubscription(now)) return null
    return (
      this.#state.snapshot?.credentialCapabilities.find(
        (capability) =>
          capability.provider === provider && capability.expiresAt > now
      )?.handle ?? null
    )
  }
}
