import type {
  CodexLoginMethod,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "@jingler/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { rpc } from "./rpc-client.js"

const CATALOG_KEY = ["provider-catalog"] as const

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Canonical provider catalog mutations; every success refreshes the one shared query. */
export function useProviderCatalog() {
  const queryClient = useQueryClient()
  const catalog = useQuery({ queryKey: CATALOG_KEY, queryFn: rpc.providerList })
  const refreshCatalog = () => queryClient.invalidateQueries({ queryKey: CATALOG_KEY })

  const refresh = useMutation({
    mutationFn: rpc.providerRefresh,
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
    connectClaude,
    startCodex,
    setApiKey,
    makeDefault
  ].find(
    ({ isPending, error }) => isPending || error !== null
  )

  return {
    catalog: catalog.data ?? null,
    busy:
      catalog.isLoading ||
      refresh.isPending ||
      verify.isPending ||
      logout.isPending ||
      connectClaude.isPending ||
      startCodex.isPending ||
      setApiKey.isPending ||
      makeDefault.isPending,
    error: catalog.error
      ? messageOf(catalog.error)
      : activeMutation?.error
        ? messageOf(activeMutation.error)
        : null,
    reload: refreshCatalog,
    refresh: refresh.mutate,
    verify: (connectionId: ProviderConnectionId, modelId: ProviderModelId) =>
      verify.mutate({ connectionId, modelId }),
    logout: logout.mutate,
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
