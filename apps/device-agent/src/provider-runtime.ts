import { AppPaths } from "@jingler/cli-adapters/app-paths"
import { SecretStore, SecretStoreUnavailable } from "@jingler/cli-adapters/secret-store"
import { AgentSecretStore } from "@jingler/cli-adapters/runtime/auth/agent-secret-store"
import { FileModelCertificationStore } from "@jingler/cli-adapters/runtime/certification/model-certification-store"
import { makeProviderCatalogService } from "@jingler/cli-adapters/runtime/providers/provider-catalog"
import {
  ProviderConnections,
  ProviderConnectionsError
} from "@jingler/cli-adapters/runtime/providers/provider-connections"
import { discoverPiModels } from "@jingler/cli-adapters/runtime/providers/pi-provider-access"
import {
  ProviderConnection
} from "@jingler/core"
import { Effect, Layer, Ref, Schema, Stream } from "effect"

const OptionalCredential = Schema.Union(
  Schema.String.pipe(Schema.minLength(1)),
  Schema.Undefined
)

interface DeviceEnvironment {
  readonly ANTHROPIC_API_KEY?: string
  readonly OPENAI_API_KEY?: string
  readonly JINGLER_CLAUDE_SETUP_TOKEN?: string
  readonly JINGLER_CODEX_OAUTH_ACCESS?: string
  readonly JINGLER_CODEX_OAUTH_REFRESH?: string
  readonly JINGLER_CODEX_OAUTH_EXPIRES_AT?: string
}

const credential = (value: string | undefined): string | undefined =>
  Schema.decodeUnknownSync(OptionalCredential)(value?.trim())

const decodeExpiry = (value: string | undefined): number | null => {
  if (value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const connection = (
  id: string,
  providerId: string,
  authKind: "claude-setup-token" | "openai-codex-oauth" | "device-environment",
  targetId: string
) => Schema.decodeUnknownSync(ProviderConnection)({
  id,
  providerId,
  authKind,
  account: null,
  targetId,
  status: "authenticated",
  subscription: {
    entitlement: "unknown",
    planLabel: null,
    expiresAt: null,
    quotaLabel: null,
    rateLimitLabel: null,
    confirmedBillingRoute:
      authKind === "device-environment" ? "device-environment" : "subscription"
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
})

const environmentState = (
  targetId: string,
  environment: DeviceEnvironment = process.env
) => {
  const entries = [
    {
      access: credential(environment.JINGLER_CLAUDE_SETUP_TOKEN),
      refresh: null,
      expiresAt: null,
      connection: connection(
        `${targetId}:claude-subscription`,
        "anthropic",
        "claude-setup-token",
        targetId
      )
    },
    {
      access: credential(environment.JINGLER_CODEX_OAUTH_ACCESS),
      refresh: credential(environment.JINGLER_CODEX_OAUTH_REFRESH) ?? null,
      expiresAt: decodeExpiry(environment.JINGLER_CODEX_OAUTH_EXPIRES_AT),
      connection: connection(
        `${targetId}:codex-subscription`,
        "openai-codex",
        "openai-codex-oauth",
        targetId
      )
    },
    {
      access: credential(environment.ANTHROPIC_API_KEY),
      refresh: null,
      expiresAt: null,
      connection: connection(
        `${targetId}:anthropic-environment`,
        "anthropic",
        "device-environment",
        targetId
      )
    },
    {
      access: credential(environment.OPENAI_API_KEY),
      refresh: null,
      expiresAt: null,
      connection: connection(
        `${targetId}:openai-environment`,
        "openai",
        "device-environment",
        targetId
      )
    }
  ].filter((entry): entry is typeof entry & { readonly access: string } =>
    entry.access !== undefined
  )

  return {
    connections: entries.map((entry) => entry.connection),
    document: JSON.stringify({
      agentCredentials: Object.fromEntries(entries.map((entry) => [
        entry.connection.id,
        {
          authKind: entry.connection.authKind,
          access: entry.access,
          refresh: entry.refresh,
          expiresAt: entry.expiresAt
        }
      ]))
    })
  }
}

const unsupported = (message: string) =>
  Effect.fail(new ProviderConnectionsError({ message }))

/** Explicit target-local environment routes used by the headless pi runtime. */
export const makeDeviceProviderLayers = (
  targetId: string,
  environment: DeviceEnvironment = process.env
) => {
  const state = environmentState(targetId, environment)
  const SecretStoreLive = Layer.effect(
    SecretStore,
    Effect.gen(function* () {
      const document = yield* Ref.make<string | null>(state.document)
      return SecretStore.of({
        get: Effect.succeed(null),
        set: () => Effect.fail(new SecretStoreUnavailable({ message: "Device sign-in storage is unavailable" })),
        clear: Effect.void,
        getOpenConnectorToken: Effect.succeed(null),
        setOpenConnectorToken: () => Effect.fail(new SecretStoreUnavailable({ message: "Device OpenConnector storage is unavailable" })),
        clearOpenConnectorToken: Effect.void,
        getDeviceSecrets: Ref.get(document),
        setDeviceSecrets: (value) => Ref.set(document, value),
        clearDeviceSecrets: Ref.set(document, null)
      })
    })
  )
  const ProviderConnectionsLive = Layer.effect(
    ProviderConnections,
    Effect.gen(function* () {
      const paths = yield* AppPaths
      const store = yield* SecretStore
      const credentials = new AgentSecretStore(store)
      const catalog = yield* makeProviderCatalogService({
        connections: Effect.succeed(state.connections),
        certifications: new FileModelCertificationStore(paths.certificationsFile),
        discover: (provider, signal) => discoverPiModels(credentials, provider, signal),
        targetAvailable: (provider) => provider.targetId === targetId
      })
      return ProviderConnections.of({
        loginEvents: Stream.empty,
        list: catalog.list.pipe(
          Effect.mapError((cause) => new ProviderConnectionsError({ message: cause.message, cause }))
        ),
        status: Effect.succeed(state.connections),
        connectClaudeToken: () => unsupported("Configure Claude subscription credentials on the target device"),
        startCodexLogin: () => unsupported("Configure Codex OAuth credentials on the target device"),
        cancelLogin: () => Effect.void,
        setApiKey: () => unsupported("Configure API credentials in the target device environment"),
        refresh: () => unsupported("Refresh target-device credentials on the target device"),
        logout: () => unsupported("Remove target-device credentials from the target environment"),
        verifyModel: () => unsupported("Run model certification on the target device")
      })
    })
  )
  return { SecretStoreLive, ProviderConnectionsLive, connections: state.connections }
}
