import type {
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
  const makeDefault = useMutation({
    mutationFn: ({ connectionId, providerId, modelId }: {
      connectionId: ProviderConnectionId
      providerId: ProviderId
      modelId: ProviderModelId
    }) => rpc.configSetDefaultProviderModel(connectionId, providerId, modelId),
    onSuccess: (config) => queryClient.setQueryData(["config"], config)
  })

  const activeMutation = [refresh, verify, logout, makeDefault].find(
    ({ isPending, error }) => isPending || error !== null
  )

  return {
    catalog: catalog.data ?? null,
    busy: catalog.isLoading || refresh.isPending || verify.isPending || logout.isPending || makeDefault.isPending,
    error: catalog.error
      ? messageOf(catalog.error)
      : activeMutation?.error
        ? messageOf(activeMutation.error)
        : null,
    refresh: refresh.mutate,
    verify: (connectionId: ProviderConnectionId, modelId: ProviderModelId) =>
      verify.mutate({ connectionId, modelId }),
    logout: logout.mutate,
    makeDefault: makeDefault.mutate
  }
}
