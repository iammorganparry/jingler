import type {
  AuthKind,
  Environment,
  CodexLoginMethod,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "@jingler/core"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { rpc } from "./rpc-client.js"

const CATALOG_KEY = ["provider-catalog"] as const
const ENDPOINT_CATALOG_KEY = ["agent-endpoint-catalog"] as const

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const catalogError = (errors: readonly unknown[]): string | null => {
  const error = errors.find(Boolean)
  return error ? messageOf(error) : null
}

/** Canonical provider catalog mutations; every success refreshes the one shared query. */
export function useProviderCatalog(environments: readonly Environment[] = []) {
  const queryClient = useQueryClient()
  // Reconnects can finish while the window is unfocused (browser OAuth, a CLI
  // login): unlike the client-wide default, re-check on focus so provider
  // recovery banners clear without a manual refresh.
  const catalog = useQuery({
    queryKey: CATALOG_KEY,
    queryFn: rpc.providerList,
    refetchOnWindowFocus: true
  })
  const endpointCatalog = useQuery({
    queryKey: ENDPOINT_CATALOG_KEY,
    queryFn: rpc.agentEndpointList,
    refetchOnWindowFocus: true
  })
  const remoteTargets = environments.flatMap((environment) => {
    const targetId = environment.capabilities?.runtime?.targetId
    return targetId && environment.kind === "owned" && environment.state === "online" ? [{ deviceId: environment.id, targetId }] : []
  })
  const remoteCatalogs = useQueries({
    queries: remoteTargets.map(({ deviceId, targetId }) => ({
      queryKey: ["remote-endpoint-catalog", deviceId, targetId],
      queryFn: () => rpc.environmentsDiscovery(deviceId, { targetId, action: "auth-status" }),
      refetchOnWindowFocus: true,
      retry: false
    }))
  })
  const refreshCatalog = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: CATALOG_KEY }),
    queryClient.invalidateQueries({ queryKey: ENDPOINT_CATALOG_KEY })
  ])

  const refresh = useMutation({
    mutationFn: async (connectionId: ProviderConnectionId) => {
      await Promise.all([
        rpc.providerRefresh(connectionId),
        rpc.agentEndpointRefresh(),
        ...remoteTargets.map(async ({ deviceId, targetId }) => {
          const discovery = await rpc.environmentsDiscovery(deviceId, { targetId, action: "refresh" })
          queryClient.setQueryData(["remote-endpoint-catalog", deviceId, targetId], discovery)
        })
      ])
    },
    onSuccess: refreshCatalog
  })
  const verify = useMutation({
    mutationFn: ({ connectionId, modelId }: {
      connectionId: ProviderConnectionId
      modelId: ProviderModelId
    }) => rpc.providerVerifyModel(connectionId, modelId),
    onSuccess: refreshCatalog
  })
  const logout = useMutation({
    mutationFn: rpc.providerLogout,
    onSuccess: refreshCatalog
  })
  const remove = useMutation({
    mutationFn: rpc.providerRemoveConnection,
    onSuccess: refreshCatalog
  })
  const connectClaude = useMutation({
    mutationFn: ({ connectionId, token }: {
      connectionId: ProviderConnectionId
      token: string
    }) => rpc.providerConnectClaudeToken({
      id: connectionId,
      token,
      targetId: "desktop"
    }),
    onSuccess: refreshCatalog
  })
  const startCodex = useMutation({
    mutationFn: ({ connectionId, method }: {
      connectionId: ProviderConnectionId
      method: CodexLoginMethod
    }) =>
      rpc.providerStartCodexLogin({
        id: connectionId,
        targetId: "desktop",
        method
      }),
    onSuccess: refreshCatalog
  })
  const setApiKey = useMutation({
    mutationFn: ({ connectionId, providerId, apiKey }: {
      connectionId: ProviderConnectionId
      providerId: ProviderId
      apiKey: string
    }) => rpc.providerSetApiKey({
      id: connectionId,
      providerId,
      apiKey,
      targetId: "desktop"
    }),
    onSuccess: refreshCatalog
  })
  const makeDefault = useMutation({
    mutationFn: ({ connectionId, providerId, modelId }: {
      connectionId: ProviderConnectionId
      providerId: ProviderId
      modelId: ProviderModelId
    }) => rpc.configSetDefaultProviderModel(connectionId, providerId, modelId),
    onSuccess: (config) => queryClient.setQueryData(["config"], config)
  })

  const activeMutation = [
    refresh,
    verify,
    logout,
    remove,
    connectClaude,
    startCodex,
    setApiKey,
    makeDefault
  ].find(
    ({ isPending, error }) => isPending || error !== null
  )
  const pendingAuthKind: AuthKind | null = connectClaude.isPending
    ? "claude-setup-token"
    : startCodex.isPending
      ? "openai-codex-oauth"
      : setApiKey.isPending
        ? "api-key"
        : null

  return {
    catalog: catalog.data ?? null,
    endpointCatalog: endpointCatalog.data ?? null,
    remoteCatalogs: remoteTargets.map(({ deviceId }, index) => ({
      deviceId,
      catalog: remoteCatalogs[index]?.data?.discovery?.capabilities.endpointCatalog
    })),
    busy:
      catalog.isLoading ||
      endpointCatalog.isLoading ||
      refresh.isPending ||
      verify.isPending ||
      logout.isPending ||
      remove.isPending ||
      connectClaude.isPending ||
      startCodex.isPending ||
      setApiKey.isPending ||
      makeDefault.isPending,
    pendingAuthKind,
    error: catalogError([catalog.error, endpointCatalog.error, activeMutation?.error, ...remoteCatalogs.map(({ error }) => error)]),
    reload: refreshCatalog,
    refresh: refresh.mutate,
    verify: (connectionId: ProviderConnectionId, modelId: ProviderModelId) =>
      verify.mutate({ connectionId, modelId }),
    logout: logout.mutate,
    remove: remove.mutate,
    connectClaude: (
      connectionId: ProviderConnectionId,
      token: string
    ) => connectClaude.mutate({ connectionId, token }),
    startCodex: (
      connectionId: ProviderConnectionId,
      method: CodexLoginMethod
    ) => startCodex.mutate({ connectionId, method }),
    setApiKey: (
      connectionId: ProviderConnectionId,
      providerId: ProviderId,
      apiKey: string
    ) => setApiKey.mutate({ connectionId, providerId, apiKey }),
    makeDefault: makeDefault.mutate
  }
}
