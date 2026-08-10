import type { AuthRouteKind } from "@jingler/core"

export interface FakeSubscriptionCredential {
  readonly route: Extract<AuthRouteKind, "claude-setup-token" | "openai-codex-oauth">
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly expiresAt: number
  readonly accountFingerprint: string
}

export type FakeEntitlement =
  | { readonly status: "active"; readonly plan: string; readonly billingRoute: "subscription" }
  | { readonly status: "revoked" | "requires-api-credits" }

const fixtureToken = (prefix: string, sequence: number): string =>
  `${prefix}-fixture-${sequence.toString().padStart(4, "0")}`

/** In-memory provider boundary used by auth contract tests; it never performs I/O. */
export class FakeSubscriptionEndpoint {
  readonly #claudeSetupToken: string
  readonly #now: () => number
  #sequence = 0
  #revoked = new Set<string>()
  #codexApproved = false

  constructor(options?: { readonly claudeSetupToken?: string; readonly now?: () => number }) {
    this.#claudeSetupToken = options?.claudeSetupToken ?? "claude-setup-fixture"
    this.#now = options?.now ?? (() => Date.now())
  }

  validateClaudeSetupToken(token: string): FakeSubscriptionCredential {
    if (token !== this.#claudeSetupToken) throw new Error("invalid-setup-token")
    this.#sequence += 1
    return {
      route: "claude-setup-token",
      accessToken: fixtureToken("claude-access", this.#sequence),
      refreshToken: null,
      expiresAt: this.#now() + 60 * 60 * 1_000,
      accountFingerprint: "claude-fixture-account"
    }
  }

  startCodexLogin(): { readonly verificationUri: string; readonly userCode: string; readonly deviceCode: string } {
    this.#codexApproved = false
    return {
      verificationUri: "https://example.invalid/device",
      userCode: "CODE-X123",
      deviceCode: "codex-device-fixture"
    }
  }

  approveCodexLogin(deviceCode: string): void {
    if (deviceCode !== "codex-device-fixture") throw new Error("invalid-device-code")
    this.#codexApproved = true
  }

  pollCodexLogin(deviceCode: string): FakeSubscriptionCredential | null {
    if (deviceCode !== "codex-device-fixture") throw new Error("invalid-device-code")
    if (!this.#codexApproved) return null
    this.#sequence += 1
    return {
      route: "openai-codex-oauth",
      accessToken: fixtureToken("codex-access", this.#sequence),
      refreshToken: fixtureToken("codex-refresh", this.#sequence),
      expiresAt: this.#now() + 60 * 60 * 1_000,
      accountFingerprint: "codex-fixture-account"
    }
  }

  refresh(credential: FakeSubscriptionCredential): FakeSubscriptionCredential {
    if (credential.refreshToken === null) throw new Error("refresh-not-supported")
    if (this.#revoked.has(credential.refreshToken)) throw new Error("credential-revoked")
    this.#sequence += 1
    return {
      ...credential,
      accessToken: fixtureToken("codex-access", this.#sequence),
      refreshToken: fixtureToken("codex-refresh", this.#sequence),
      expiresAt: this.#now() + 60 * 60 * 1_000
    }
  }

  revoke(credential: FakeSubscriptionCredential): void {
    this.#revoked.add(credential.refreshToken ?? credential.accessToken)
  }

  entitlement(
    credential: FakeSubscriptionCredential,
    mode: "active" | "requires-api-credits" = "active"
  ): FakeEntitlement {
    if (this.#revoked.has(credential.refreshToken ?? credential.accessToken)) {
      return { status: "revoked" }
    }
    return mode === "requires-api-credits"
      ? { status: "requires-api-credits" }
      : { status: "active", plan: "fixture-subscription", billingRoute: "subscription" }
  }
}
