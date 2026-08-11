export interface AuthStateClientConfig {
  readonly enabled: boolean
  readonly url: string
  readonly serviceSecret: string
  readonly fetch?: typeof fetch
}

interface AuthSessionState {
  readonly id: string
  readonly userId: string
  readonly expiresAt: Date
}

export type AuthCapabilityProvider = "github" | "codex" | "claude"
export type AuthCapabilityUpstream =
  | "github-api"
  | "openai-api"
  | "chatgpt-codex"
  | "anthropic-api"

interface AuthCapabilityState {
  readonly userId: string
  readonly provider: AuthCapabilityProvider
  readonly authorizationHeader: string
  readonly expiresAt: Date
  readonly upstream?: AuthCapabilityUpstream
  readonly accountId?: string
}

const endpoint = (config: AuthStateClientConfig, userId: string): string =>
  new URL(
    `/v1/internal/users/${encodeURIComponent(userId)}/session`,
    config.url
  ).toString()

const send = async (
  config: AuthStateClientConfig,
  input: AuthSessionState,
  method: "PUT" | "DELETE"
): Promise<void> => {
  if (!config.enabled) return
  const response = await (config.fetch ?? fetch)(endpoint(config, input.userId), {
    method,
    headers: {
      "content-type": "application/json",
      "x-jingler-service-secret": config.serviceSecret
    },
    body: JSON.stringify({
      sessionId: input.id,
      expiresAt: Math.floor(input.expiresAt.getTime() / 1_000)
    })
  })
  if (!response.ok) {
    throw new Error(`Auth-state session sync failed (${response.status})`)
  }
}

export const upsertAuthStateSession = (
  config: AuthStateClientConfig,
  input: AuthSessionState
): Promise<void> => send(config, input, "PUT")

export const deleteAuthStateSession = (
  config: AuthStateClientConfig,
  input: AuthSessionState
): Promise<void> => send(config, input, "DELETE")

const capabilityEndpoint = (
  config: AuthStateClientConfig,
  userId: string
): string =>
  new URL(
    `/v1/internal/users/${encodeURIComponent(userId)}/capability`,
    config.url
  ).toString()

export const upsertAuthStateCapability = async (
  config: AuthStateClientConfig,
  input: AuthCapabilityState
): Promise<void> => {
  if (!config.enabled) return
  const response = await (config.fetch ?? fetch)(
    capabilityEndpoint(config, input.userId),
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-jingler-service-secret": config.serviceSecret
      },
      body: JSON.stringify({
        provider: input.provider,
        authorizationHeader: input.authorizationHeader,
        expiresAt: Math.floor(input.expiresAt.getTime() / 1_000),
        ...(input.upstream === undefined ? {} : { upstream: input.upstream }),
        ...(input.accountId === undefined ? {} : { accountId: input.accountId })
      })
    }
  )
  if (!response.ok) {
    throw new Error(`Auth-state capability sync failed (${response.status})`)
  }
}

export const deleteAuthStateCapability = async (
  config: AuthStateClientConfig,
  input: { readonly userId: string; readonly provider: AuthCapabilityProvider }
): Promise<void> => {
  if (!config.enabled) return
  const response = await (config.fetch ?? fetch)(
    capabilityEndpoint(config, input.userId),
    {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-jingler-service-secret": config.serviceSecret
      },
      body: JSON.stringify({ provider: input.provider })
    }
  )
  if (!response.ok) {
    throw new Error(`Auth-state capability sync failed (${response.status})`)
  }
}
