import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai"
import {
  ProviderId,
  ProviderModelId,
  type AuthKind,
  type ProviderConnection,
  type ReasoningEffort
} from "@jingler/core"
import { Effect, Schema } from "effect"
import type { ProviderCredentialStore } from "../auth/credential-store.js"
import type { EntitlementProbeResult } from "../auth/auth-broker.js"
import { makePiCredentialStore } from "../auth/pi-credential-store.js"
import { ProviderCatalogError, type DiscoveredProviderModel } from "./provider-catalog.js"

const credentialFor = (authKind: AuthKind, access: string): Credential =>
  authKind === "openai-codex-oauth" || authKind === "claude-setup-token"
    ? {
        type: "oauth",
        access,
        refresh: "",
        expires:
          authKind === "claude-setup-token"
            ? Number.MAX_SAFE_INTEGER
            : Date.now() + 10 * 60_000
      }
    : { type: "api_key", key: access }

/** A single explicit credential with no environment or unrelated-store fallback. */
const isolatedCredentialStore = (
  providerId: string,
  initial: Credential
): CredentialStore => {
  let credential: Credential | undefined = initial
  let pending: Promise<void> = Promise.resolve()
  const serialize = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = pending.then(operation, operation)
    pending = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    read: async (requested) => requested === providerId ? credential : undefined,
    list: async (): Promise<ReadonlyArray<CredentialInfo>> =>
      credential === undefined
        ? []
        : [{ providerId, type: credential.type }],
    modify: (requested, change) =>
      serialize(async () => {
        if (requested !== providerId) return
        credential = await change(credential)
        return credential
      }),
    delete: (requested) =>
      serialize(async () => {
        if (requested === providerId) credential = undefined
      })
  }
}

const CLAUDE_SETUP_TOKEN_ENTITLEMENT_MODEL = "claude-haiku-4-5"

export const selectEntitlementModel = <Model extends { readonly id: string }>(
  models: ReadonlyArray<Model>,
  authKind: AuthKind
): Model => {
  const model = authKind === "claude-setup-token"
    ? models.find(({ id }) => id === CLAUDE_SETUP_TOKEN_ENTITLEMENT_MODEL) ?? models[0]
    : models[0]
  if (!model) throw new Error("No authenticated model is available")
  return model
}

const entitlementModel = async (
  runtime: ModelRuntime,
  providerId: string,
  authKind: AuthKind,
  signal: AbortSignal
) => {
  const models = await runtime.getAvailable(providerId, { signal })
  return selectEntitlementModel(models, authKind)
}

const routeLabel = (authKind: AuthKind): string => {
  switch (authKind) {
    case "claude-setup-token":
      return "claude-oauth"
    case "openai-codex-oauth":
      return "chatgpt-subscription"
    case "api-key":
      return "api-key"
    case "device-environment":
      return "device-environment"
  }
}

const redactedEndpoint = (baseUrl: string): string => {
  const endpoint = new URL(baseUrl)
  endpoint.username = ""
  endpoint.password = ""
  endpoint.search = ""
  endpoint.hash = ""
  return endpoint.toString().replace(/\/$/u, "")
}

const observedRoute = (
  authKind: AuthKind,
  model: Awaited<ReturnType<typeof entitlementModel>>
): string =>
  `${routeLabel(authKind)}:${model.api}:${redactedEndpoint(model.baseUrl)}`

/** Verify entitlement with a minimal request through only the selected auth route. */
export const probePiEntitlement = async (input: {
  readonly providerId: string
  readonly authKind: AuthKind
  readonly access: string
  readonly signal: AbortSignal
}): Promise<EntitlementProbeResult> => {
  const runtime = await ModelRuntime.create({
    credentials: isolatedCredentialStore(
      input.providerId,
      credentialFor(input.authKind, input.access)
    ),
    modelsPath: null,
    refreshOnCreate: true,
    signal: input.signal
  })
  const model = await entitlementModel(
    runtime,
    input.providerId,
    input.authKind,
    input.signal
  )
  const response = await runtime.completeSimple(
    model,
    {
      messages: [
        { role: "user", content: "Reply with OK.", timestamp: Date.now() }
      ]
    },
    { signal: input.signal }
  )
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? "Provider entitlement probe failed")
  }
  return {
    entitlement: "active",
    planLabel: null,
    quotaLabel: null,
    rateLimitLabel: null,
    billingRoute:
      input.authKind === "api-key"
        ? "api"
        : input.authKind === "device-environment"
          ? "device-environment"
          : "subscription",
    observedRoute: observedRoute(input.authKind, model)
  }
}

const reasoningLevels = (enabled: boolean): ReadonlyArray<ReasoningEffort> =>
  enabled ? ["low", "medium", "high"] : []

/** Discover models through the connection-pinned credential store, never PATH. */
export const discoverPiModels = (
  credentials: ProviderCredentialStore,
  connection: ProviderConnection,
  signal: AbortSignal
): Effect.Effect<ReadonlyArray<DiscoveredProviderModel>, ProviderCatalogError> =>
  Effect.tryPromise({
    try: async () => {
      const runtime = await ModelRuntime.create({
        credentials: makePiCredentialStore(connection, credentials),
        modelsPath: null,
        refreshOnCreate: true,
        signal
      })
      return (await runtime.getAvailable(connection.providerId, { signal })).map(
        (model) => ({
          providerId: Schema.decodeUnknownSync(ProviderId)(model.provider),
          id: Schema.decodeUnknownSync(ProviderModelId)(
            `${model.provider}/${model.id}`
          ),
          label: model.name,
          capabilities: {
            contextWindow: model.contextWindow,
            reasoning: reasoningLevels(model.reasoning),
            vision: model.input.includes("image")
          }
        })
      )
    },
    catch: (cause) =>
      new ProviderCatalogError({
        message: "Failed to discover provider models",
        cause
      })
  })
