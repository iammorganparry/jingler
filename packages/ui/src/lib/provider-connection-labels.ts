import type { AuthKind, AuthStatus, SubscriptionStatus } from "@jingler/core"

export const providerAuthRouteLabel = (authKind: AuthKind): string => {
  switch (authKind) {
    case "claude-setup-token":
      return "Claude CLI subscription"
    case "openai-codex-oauth":
      return "ChatGPT Codex subscription"
    case "api-key":
      return "Provider API key"
    case "device-environment":
      return "Execution-device environment"
  }
}

export const providerStatusTone = (status: AuthStatus): string =>
  status === "authenticated"
    ? "bg-green"
    : status === "connecting"
      ? "bg-yellow"
      : "bg-red"

/** Why a connection that reached the provider is still not usable. */
export const entitlementIssueLabel = (
  subscription: SubscriptionStatus
): string => {
  switch (subscription.entitlement) {
    case "requires-api-credits":
      return "The provider answered, but over a route billed as API credits rather than your subscription plan. Jingler never falls a subscription connection back to an API key, so this connection stays unused."
    case "unavailable":
      return "The provider rejected this account's entitlement. Confirm the subscription is active, then reconnect."
    default:
      return "Connected, but the subscription entitlement could not be confirmed. Retry the connection."
  }
}
