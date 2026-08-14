import type { ProviderCatalog, ProviderId, ProviderUsage, Usage } from "@jingler/core"
import { Effect } from "effect"

const providerName = (providerId: ProviderId): string => {
  switch (providerId) {
    case "anthropic":
      return "Anthropic"
    case "openai":
    case "openai-codex":
      return "OpenAI"
    case "google":
      return "Google"
    case "openrouter":
      return "OpenRouter"
    default:
      return providerId
  }
}

const usageFromConnection = (
  entry: ProviderCatalog["connections"][number]
): ProviderUsage => {
  const { connection } = entry
  const { subscription } = connection
  return {
    connectionId: connection.id,
    providerId: connection.providerId,
    authKind: connection.authKind,
    authStatus: connection.status,
    billingRoute: subscription.confirmedBillingRoute,
    targetId: connection.targetId,
    quotaLabel: subscription.quotaLabel,
    rateLimitLabel: subscription.rateLimitLabel,
    name: connection.account?.displayLabel ?? providerName(connection.providerId),
    plan: subscription.planLabel,
    available: subscription.quotaLabel !== null || subscription.rateLimitLabel !== null,
    windows: []
  }
}

/** Builds renderer-safe usage metadata from explicit provider connections. */
export class UsageService extends Effect.Service<UsageService>()("@jingler/UsageService", {
  accessors: true,
  sync: () => ({
    fromProviderCatalog: (catalog: ProviderCatalog): Effect.Effect<Usage> =>
      Effect.succeed({
        providers: catalog.connections.map(usageFromConnection),
        fetchedAt: catalog.refreshedAt
      })
  })
}) {}
