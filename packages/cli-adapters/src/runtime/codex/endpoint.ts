import {
  nativeCliEndpointId,
  ProviderId,
  ProviderModelId,
  type AgentEndpointCatalogEntry,
  type ReasoningEffort,
  type AgentEndpointStatus
} from "@jingler/core"
import {
  CODEX_PROTOCOL_VERSION,
  UnsupportedCodexPlatformError,
  readCodexVersion,
  CodexClient,
  type CodexClientOptions
} from "./client.js"
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.js"
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js"
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse.js"

const isEffort = (value: string): value is ReasoningEffort =>
  ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value)

export { CODEX_PROTOCOL_VERSION } from "./client.js"
export const codexFeatures = {
  steer: "text",
  planReview: false,
  subagentFleet: true,
  backgroundTasks: true
} as const
export interface CodexProbeOptions extends CodexClientOptions {
  readonly targetId?: string
}
const catalogModel = (
  model: ModelListResponse["data"][number],
  status: AgentEndpointStatus
): AgentEndpointCatalogEntry["models"][number] => {
  const efforts = model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort)
  return {
    providerId: ProviderId.make("openai"),
    id: ProviderModelId.make(model.model),
    label: (model.displayName || model.model).slice(0, 256),
    capabilities: {
      contextWindow: null,
      reasoning: [...new Set(efforts.filter(isEffort))],
      reasoningCanDisable: efforts.includes("none"),
      ...(isEffort(model.defaultReasoningEffort)
        ? { reasoningDefault: model.defaultReasoningEffort }
        : {}),
      vision: model.inputModalities.includes("image"),
      nativeWebSearch: false
    },
    verification: "unverified",
    certificationKey: null,
    status: status === "ready" ? "ready" : "unavailable",
    selectable: status === "ready"
  }
}

const listModels = async (client: CodexClient, status: AgentEndpointStatus) => {
  const models: AgentEndpointCatalogEntry["models"][number][] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  const modelIds = new Set<string>()
  for (let page = 0; page < 32; page++) {
    const response: ModelListResponse = await client.request("model/list", {
      cursor,
      limit: 100,
      includeHidden: false
    })
    for (const model of response.data) {
      if (model.hidden || modelIds.has(model.model)) continue
      modelIds.add(model.model)
      models.push(catalogModel(model, status))
      if (models.length === 256) return models
    }
    cursor = response.nextCursor
    if (cursor === null) break
    if (seen.has(cursor) || page === 31) throw new Error("Codex model pagination exceeded bound")
    seen.add(cursor)
  }
  return models
}

const probeFailureStatus = (error: unknown): AgentEndpointStatus => {
  if (error instanceof UnsupportedCodexPlatformError) return "unsupported"
  return error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "error"
}

export const probeCodexEndpoint = async (
  options: CodexProbeOptions = {}
): Promise<AgentEndpointCatalogEntry> => {
  let version: string | null = null
  let status: AgentEndpointStatus = "error"
  const models: AgentEndpointCatalogEntry["models"][number][] = []
  let client: CodexClient | undefined
  try {
    version = await readCodexVersion(options)
    client = new CodexClient(options)
    await client.initialize()
    const account = await client.request<GetAccountResponse>("account/read", {
      refreshToken: false
    })
    status = account.account === null && account.requiresOpenaiAuth ? "signed-out" : "ready"
    if (status === "ready") models.push(...(await listModels(client, status)))
  } catch (error) {
    status = probeFailureStatus(error)
  } finally {
    await client?.close()
  }
  const targetId = options.targetId ?? "desktop"
  return {
    endpoint: {
      id: nativeCliEndpointId(targetId, "codex"),
      runtimeId: "codex",
      targetId,
      label: "Codex CLI",
      status,
      version,
      protocolVersion: CODEX_PROTOCOL_VERSION,
      features: codexFeatures
    },
    models:
      status === "ready"
        ? models
        : models.map((model) => ({ ...model, status: "unavailable", selectable: false }))
  }
}

/** Native login owns a short-lived app-server, never PI OAuth or credential files. */
export const startCodexEndpointLogin = async (options: CodexClientOptions = {}) => {
  const client = new CodexClient(options)
  try {
    await client.initialize()
    const early = new Map<string, boolean>()
    let finish: ((success: boolean) => void) | undefined
    let loginId: string | undefined
    client.onMessage((message) => {
      if (
        message.method !== "account/login/completed" ||
        typeof message.params.loginId !== "string"
      )
        return
      const success = message.params.success === true
      if (message.params.loginId === loginId) finish?.(success)
      else if (early.size < 32) early.set(message.params.loginId, success)
    })
    const result = await client.request<LoginAccountResponse>("account/login/start", {
      type: "chatgptDeviceCode"
    })
    if (result.type !== "chatgptDeviceCode") throw new Error("Unexpected Codex login response")
    loginId = result.loginId
    let settled = false
    const completed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish?.(false), 10 * 60_000)
      finish = (success) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(success)
        void client.close()
      }
      client.onFailure(() => finish?.(false))
      if (early.has(result.loginId)) finish(early.get(result.loginId)!)
    })
    return {
      ...result,
      completed,
      cancel: async () => {
        try {
          if (!settled) await client.request("account/login/cancel", { loginId })
        } finally {
          finish?.(false)
          await client.close()
        }
      }
    }
  } catch (error) {
    await client.close()
    throw error
  }
}
