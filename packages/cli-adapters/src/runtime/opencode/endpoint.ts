import { nativeCliEndpointId, ProviderId, ProviderModelId, type AgentEndpointCatalogEntry, type AgentEndpointStatus } from "@jingler/core"
import type { ConfigProvidersResponse, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { acquireOpenCode, makeOpenCodePool, OPENCODE_VERSION, UnsupportedOpenCode, type OpenCodeOptions, type OpenCodeServer } from "./server.js"

export const openCodeFeatures = { steer: "none", planReview: false, subagentFleet: false, backgroundTasks: false } as const
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validates bounded provider and model identities in one catalog pass.
export const catalogModels = (providers: ProviderListResponse, config: ConfigProvidersResponse): AgentEndpointCatalogEntry["models"] => {
  const connected = new Set(providers.connected)
  const configured = new Set(config.providers.map((provider) => provider.id))
  const seen = new Set<string>()
  const models: AgentEndpointCatalogEntry["models"][number][] = []
  if (providers.all.length > 256 || connected.size > 256 || configured.size > 256) throw new Error("OpenCode provider bound exceeded")
  for (const provider of providers.all) {
    if (!connected.has(provider.id) || !configured.has(provider.id)) continue
    if (!provider.id || provider.id.length > 256) throw new Error("Invalid OpenCode provider identity")
    for (const model of Object.values(provider.models)) {
      const key = JSON.stringify([provider.id, model.id])
      if (seen.has(key)) continue
      if (!model.id || model.id.length > 256 || model.providerID !== provider.id) throw new Error("Invalid OpenCode model identity")
      seen.add(key)
      const ready = connected.has(provider.id) && configured.has(provider.id) && model.status !== "deprecated"
      models.push({
        providerId: ProviderId.make(provider.id), id: ProviderModelId.make(model.id), label: model.name.slice(0, 256),
        capabilities: { contextWindow: Number.isSafeInteger(model.limit.context) && model.limit.context > 0 ? model.limit.context : null, reasoning: [], reasoningCanDisable: false, vision: model.capabilities.input.image, nativeWebSearch: false },
        verification: "unverified", certificationKey: null, status: ready ? "ready" : "unavailable", selectable: ready
      })
      if (models.length >= 256) return models
    }
  }
  return models
}
export const readOpenCodeModels = async (server: OpenCodeServer, directory?: string, signal?: AbortSignal) => {
  const request = { throwOnError: true as const, ...(signal ? { signal } : {}) }
  const [providers, config] = await Promise.all([
    server.client.provider.list({ directory }, request),
    server.client.config.providers({ directory }, request)
  ])
  return catalogModels(providers.data, config.data)
}
export const probeOpenCodeEndpoint = async (options: OpenCodeOptions & { targetId?: string } = {}): Promise<AgentEndpointCatalogEntry> => {
  const targetId = options.targetId ?? "desktop"
  let version: string | null = null
  let status: AgentEndpointStatus = "error"
  let models: AgentEndpointCatalogEntry["models"] = []
  try {
    const lease = await (Object.keys(options).some((key) => key !== "targetId") ? makeOpenCodePool(options) : acquireOpenCode)(targetId)
    try {
      version = OPENCODE_VERSION
      models = await readOpenCodeModels(lease.server)
      status = models.some((model) => model.selectable) ? "ready" : "signed-out"
    } finally { await lease.release() }
  } catch (error) {
    status = error instanceof UnsupportedOpenCode ? "unsupported" : error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "error"
  }
  return { endpoint: { id: nativeCliEndpointId(targetId, "opencode"), runtimeId: "opencode", targetId, label: "OpenCode CLI", status, version, protocolVersion: OPENCODE_VERSION, features: openCodeFeatures }, models }
}
