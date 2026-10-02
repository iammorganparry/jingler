import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type ProviderResponse
} from "@earendil-works/pi-ai"
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
import {
  createClaudeCliStreamSimple,
  verifyLocalClaudeSubscription,
  type ClaudeCliProviderOptions
} from "./claude-cli-provider.js"
import {
  readCodexModelCatalog,
  type CodexModelCatalogEntry,
  type CodexModelCatalogOptions
} from "../codex/endpoint.js"

const credentialFor = (authKind: AuthKind, access: string): Credential =>
  authKind === "openai-codex-oauth"
    ? { type: "oauth", access, refresh: "", expires: Date.now() + 10 * 60_000 }
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

const TRAILING_SLASH = /\/$/u

const ASTRA_MODEL = {
  id: "gpt-6-astra",
  name: "GPT-6 Astra",
  api: "openai-codex-responses" as const,
  reasoning: true,
  thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" } as const,
  input: ["text", "image"] as Array<"text" | "image">,
  cost: {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }]
  },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
  compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true }
}

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

const cliThinkingLevelMap = (
  model: CodexModelCatalogEntry
): NonNullable<Model<Api>["thinkingLevelMap"]> => {
  const supported = new Set(model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
    reasoningEffort === "none" ? "off" : reasoningEffort
  ))
  return Object.fromEntries(PI_THINKING_LEVELS.map((level) => [
    level,
    supported.has(level) ? (level === "off" ? "none" : level) : null
  ]))
}

const modelTemplate = (
  models: ReadonlyArray<Model<Api>>,
  id: string
): Model<Api> | undefined => {
  const family = id.split("-").at(-1)
  return models.find((model) => family !== undefined && model.id.endsWith(`-${family}`))
    ?? models.find((model) => model.id === "gpt-5.6-sol")
    ?? models.at(-1)
}

const withCliCodexModels = (
  models: ReadonlyArray<Model<Api>>,
  catalog: ReadonlyArray<CodexModelCatalogEntry>
): ReadonlyArray<Model<Api>> => {
  const existing = new Set(models.map(({ id }) => id))
  return [
    ...models,
    ...catalog.flatMap((entry): ReadonlyArray<Model<Api>> => {
      if (entry.hidden || existing.has(entry.model)) return []
      const template = modelTemplate(models, entry.model)
      if (template === undefined) return []
      existing.add(entry.model)
      return [{
        ...template,
        id: entry.model,
        name: entry.displayName || entry.model,
        reasoning: entry.supportedReasoningEfforts.length > 0,
        thinkingLevelMap: cliThinkingLevelMap(entry),
        input: entry.inputModalities.filter(
          (input): input is "text" | "image" => input === "text" || input === "image"
        )
      }]
    })
  ]
}

export const registerJinglerModels = async (
  runtime: ModelRuntime,
  options: CodexModelCatalogOptions = {}
): Promise<void> => {
  const codex = runtime.getProvider("openai-codex")
  if (codex === undefined) return
  if (!codex.getModels().some(({ id }) => id === ASTRA_MODEL.id)) {
    runtime.registerProvider("openai-codex", {
      ...runtime.getRegisteredProviderConfig("openai-codex"),
      models: [...codex.getModels(), ASTRA_MODEL]
    })
  }
  const models = runtime.getProvider("openai-codex")!.getModels()
  const catalog = await readCodexModelCatalog({ timeoutMs: 5_000, ...options }).catch(() => [])
  runtime.registerProvider("openai-codex", {
    ...runtime.getRegisteredProviderConfig("openai-codex"),
    models: [...withCliCodexModels(models, catalog)]
  })
}

export const registerClaudeCliProvider = (
  runtime: ModelRuntime,
  options: ClaudeCliProviderOptions
): void => {
  const anthropic = runtime.getProvider("anthropic")
  if (!anthropic?.getModels().every(({ api }) => api === "anthropic-messages")) return
  const models = anthropic.getModels()
  // Claude CLI accepts documented aliases that pi's static model catalog omits.
  const aliases = ([
    ["opus", "claude-opus", "Claude Opus (latest)"],
    ["sonnet", "claude-sonnet", "Claude Sonnet (latest)"],
    ["haiku", "claude-haiku", "Claude Haiku (latest)"]
  ] as const).flatMap(([id, prefix, name]) => {
    const base = models.find((model) => model.id.startsWith(prefix))
    return base === undefined || models.some((model) => model.id === id)
      ? []
      : [{ ...base, id, name }]
  })
  // Claude CLI ships this id before pi's catalogue; inherit metadata until pi catches up.
  const opus5 = runtime.getModel("anthropic", "claude-opus-5")
  const opus55 = opus5 === undefined || models.some(({ id }) => id === "claude-opus-5-5")
    ? []
    : [{ ...opus5, id: "claude-opus-5-5", name: "Claude Opus 5.5" }]
  runtime.registerProvider("anthropic", {
    ...runtime.getRegisteredProviderConfig("anthropic"),
    api: "anthropic-messages",
    streamSimple: createClaudeCliStreamSimple(options),
    models: [...models, ...aliases, ...opus55]
  })
}

const entitlementModels = async (
  runtime: ModelRuntime,
  providerId: string,
  signal: AbortSignal
) => {
  const models = await runtime.getAvailable(providerId, { signal })
  if (models.length === 0) throw new Error("No authenticated model is available")
  return models
}

// A plan can authenticate yet exclude a catalogued model (ChatGPT accounts
// reject the Pro-only codex-spark). That says nothing about entitlement, so the
// probe moves on to the next model instead of failing the connection.
const MODEL_UNSUPPORTED = /model is not supported|model_not_supported|unsupported model/i

/** Whether a probe failure is about the model, not the account. */
export const isModelUnsupportedError = (message: string): boolean =>
  MODEL_UNSUPPORTED.test(message)

const redactedEndpoint = (baseUrl: string): string => {
  const endpoint = new URL(baseUrl)
  endpoint.username = ""
  endpoint.password = ""
  endpoint.search = ""
  endpoint.hash = ""
  return endpoint.toString().replace(TRAILING_SLASH, "")
}

interface ObservedProviderRoute {
  readonly provider: string
  readonly api: string
  readonly baseUrl: string
}

/** Classify only routes established by the actual provider response path. */
export const classifyObservedBillingRoute = (
  authKind: AuthKind,
  model: ObservedProviderRoute
): EntitlementProbeResult["billingRoute"] => {
  if (authKind === "api-key") return "api"
  if (authKind === "device-environment") return "device-environment"
  const endpoint = new URL(model.baseUrl)
  if (
    authKind === "openai-codex-oauth" &&
    model.provider === "openai-codex" &&
    model.api === "openai-codex-responses" &&
    endpoint.hostname === "chatgpt.com" &&
    endpoint.pathname.startsWith("/backend-api")
  ) return "subscription"
  return null
}

const observedRoute = (
  model: ObservedProviderRoute,
  response: ProviderResponse
): string =>
  `${model.provider}:${model.api}:${redactedEndpoint(model.baseUrl)}:http-${response.status}`

/** Verify entitlement with a minimal request through only the selected auth route. */
export const probePiEntitlement = async (input: {
  readonly providerId: string
  readonly authKind: AuthKind
  readonly access: string
  readonly signal: AbortSignal
}): Promise<EntitlementProbeResult> => {
  if (input.authKind === "claude-setup-token") {
    await verifyLocalClaudeSubscription({ signal: input.signal })
    return {
      entitlement: "active",
      planLabel: "Claude subscription",
      quotaLabel: null,
      rateLimitLabel: null,
      billingRoute: "subscription",
      observedRoute: "claude-cli:subscription"
    }
  }
  const runtime = await ModelRuntime.create({
    credentials: isolatedCredentialStore(
      input.providerId,
      credentialFor(input.authKind, input.access)
    ),
    modelsPath: null,
    refreshOnCreate: true,
    signal: input.signal
  })
  if (input.providerId === "openai-codex") await registerJinglerModels(runtime)
  const models = await entitlementModels(runtime, input.providerId, input.signal)
  let lastError: Error | null = null
  for (const model of models) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: stop at the first model the plan accepts.
      return await probeModel(runtime, model, input)
    } catch (error) {
      if (!(error instanceof Error) || !isModelUnsupportedError(error.message)) throw error
      lastError = error
    }
  }
  throw lastError ?? new Error("Provider entitlement probe failed")
}

const probeModel = async (
  runtime: ModelRuntime,
  model: Model<Api>,
  input: { readonly authKind: AuthKind; readonly signal: AbortSignal }
): Promise<EntitlementProbeResult> => {
  let providerResponse: ProviderResponse | null = null
  const response = await runtime.completeSimple(
    model,
    {
      messages: [
        { role: "user", content: "Reply with OK.", timestamp: Date.now() }
      ]
    },
    {
      signal: input.signal,
      // The probe exists to observe the HTTP route. Codex defaults to a
      // WebSocket transport whose responses never reach onResponse, which
      // would fail a fully entitled account with "no observable HTTP route".
      transport: "sse",
      onResponse: (observed, responseModel) => {
        if (
          responseModel.provider === model.provider &&
          responseModel.api === model.api &&
          responseModel.baseUrl === model.baseUrl
        ) providerResponse = observed
      }
    }
  )
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? "Provider entitlement probe failed")
  }
  if (providerResponse === null) {
    throw new Error("Provider entitlement probe returned no observable HTTP route")
  }
  const billingRoute = classifyObservedBillingRoute(input.authKind, model)
  const intendedSubscription = input.authKind === "openai-codex-oauth"
  return {
    entitlement:
      intendedSubscription && billingRoute !== "subscription"
        ? "requires-api-credits"
        : "active",
    planLabel: null,
    quotaLabel: null,
    rateLimitLabel: null,
    billingRoute,
    observedRoute: observedRoute(model, providerResponse)
  }
}

export const modelReasoningCapabilities = (model: Model<Api>) => {
  const levels = getSupportedThinkingLevels(model)
  const resolvedDefault = clampThinkingLevel(model, "medium")
  return {
    reasoning: levels.filter(
      (level): level is ReasoningEffort => level !== "off"
    ),
    reasoningCanDisable: levels.includes("off"),
    ...(resolvedDefault === "off"
      ? {}
      : { reasoningDefault: resolvedDefault as ReasoningEffort })
  }
}

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
      if (connection.providerId === "openai-codex") await registerJinglerModels(runtime)
      if (connection.authKind === "claude-setup-token") {
        registerClaudeCliProvider(runtime, {})
      }
      return (await runtime.getAvailable(connection.providerId, { signal })).map(
        (model) => ({
          providerId: Schema.decodeUnknownSync(ProviderId)(model.provider),
          id: Schema.decodeUnknownSync(ProviderModelId)(
            `${model.provider}/${model.id}`
          ),
          label: model.name,
          capabilities: {
            contextWindow: model.contextWindow,
            ...modelReasoningCapabilities(model),
            vision: model.input.includes("image"),
            // pi-ai 0.84 exposes function tools only; provider-native server
            // tools cannot be certified or installed through this adapter yet.
            nativeWebSearch: false
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
