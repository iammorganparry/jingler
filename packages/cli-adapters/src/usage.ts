import type { ProviderCatalog, ProviderId, ProviderUsage, Usage } from "@jingler/core"
import { Effect } from "effect"
import type { ProviderUsageRead } from "./runtime/providers/pi-provider-usage.js"

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

const withLive = (
  base: ProviderUsage,
  live: ProviderUsageRead
): ProviderUsage => {
  if (live === null) return base
  if (!live.available) return { ...base, unavailableReason: live.reason }
  return {
    ...base,
    plan: live.usage.plan ?? base.plan,
    available: true,
    windows: live.usage.windows
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
      }),
    /**
     * Usage with live plan windows: `fetchLive` reads each authenticated
     * connection's provider usage endpoint; a failed or unsupported read
     * degrades that connection to the metadata-only row.
     */
    liveFromProviderCatalog: (
      catalog: ProviderCatalog,
      fetchLive: (
        entry: ProviderCatalog["connections"][number]
      ) => Effect.Effect<ProviderUsageRead>
    ): Effect.Effect<Usage> =>
      Effect.forEach(
        catalog.connections,
        (entry) =>
          fetchLive(entry).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
            Effect.map((live) => withLive(usageFromConnection(entry), live))
          ),
        { concurrency: 4 }
      ).pipe(
        Effect.map((providers) => ({
          providers,
          fetchedAt: new Date().toISOString()
        }))
      )
  })
}) {}
