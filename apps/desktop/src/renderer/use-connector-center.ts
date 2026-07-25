import type {
  ConnectorConnection,
  ConnectorProvider,
  OAuthClientInfo
} from "@starbase/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { rpc } from "./rpc-client.js"
import { openConnectorKey } from "./use-open-connector.js"

/**
 * State for the MCP Connector Center: the OpenConnector provider catalog, the
 * operator's connections, and the OAuth-client metadata — plus the mutations to
 * connect / disconnect / start OAuth.
 *
 * `connections` is the source of truth for "is this connected?", so it is refetched
 * after every mutation AND explicitly after `startOauth` — the OAuth consent
 * finishes in the system browser (OpenConnector stores the grant), so the only way
 * the panel learns about it is by re-polling. No secret is ever read back: values
 * flow one way, into the mutations.
 */

export const connectorProvidersKey = ["connector", "providers"] as const
export const connectorConnectionsKey = ["connector", "connections"] as const
export const connectorOauthKey = ["connector", "oauth-configs"] as const

/**
 * Field names mirror `ConnectorCenterProps` (in `@starbase/ui`) so the hook's
 * return value can be spread straight onto `<ConnectorCenter>` / passed as the
 * `connector` prop with no adapter.
 */
export interface ConnectorCenterState {
  readonly providers: ReadonlyArray<ConnectorProvider>
  readonly connections: ReadonlyArray<ConnectorConnection>
  readonly oauthConfigs: ReadonlyArray<OAuthClientInfo>
  readonly loading: boolean
  /** Non-null when a read failed (e.g. OpenConnector not configured / unreachable). */
  readonly error: string | null
  readonly onConnect: (
    service: string,
    authType: "api_key" | "custom_credential",
    values: Record<string, string>
  ) => Promise<void>
  readonly onDisconnect: (service: string) => Promise<void>
  readonly onSetOauthConfig: (
    provider: string,
    clientId: string,
    clientSecret: string
  ) => Promise<void>
  readonly onStartOauth: (service: string) => Promise<void>
  /** Force a connections re-poll (the "I've finished connecting" affordance). */
  readonly onRefresh: () => void
}

export function useConnectorCenter(): ConnectorCenterState {
  const queryClient = useQueryClient()

  // The hook is mounted for the whole session (AuthedApp), so the catalog reads
  // must NOT fire until OpenConnector is actually configured — otherwise they fail
  // at boot and, with a long staleTime, never recover. This shares the Settings
  // panel's query key, so saving the config there invalidates it and flips these
  // queries on without an app restart.
  const configQuery = useQuery({
    queryKey: openConnectorKey,
    queryFn: () => rpc.openConnectorGet(),
    staleTime: Infinity
  })
  const ready = (configQuery.data?.config.enabled ?? false) && (configQuery.data?.hasToken ?? false)

  const providersQuery = useQuery({
    queryKey: connectorProvidersKey,
    queryFn: () => rpc.connectorProviders(),
    enabled: ready,
    // The catalog is stable; don't refetch on every focus.
    staleTime: 5 * 60 * 1000
  })
  const connectionsQuery = useQuery({
    queryKey: connectorConnectionsKey,
    queryFn: () => rpc.connectorConnections(),
    enabled: ready
  })
  const oauthQuery = useQuery({
    queryKey: connectorOauthKey,
    queryFn: () => rpc.connectorOauthConfigs(),
    enabled: ready,
    staleTime: 5 * 60 * 1000
  })

  const refreshConnections = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: connectorConnectionsKey })
  }, [queryClient])

  // The manual "Refresh" affordance re-reads the WHOLE surface (catalog, oauth,
  // connections) — a connect done in the browser can change any of them.
  const onRefresh = useCallback(() => {
    for (const key of [connectorProvidersKey, connectorConnectionsKey, connectorOauthKey]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }, [queryClient])

  const connectMutation = useMutation({
    mutationFn: (args: {
      service: string
      authType: "api_key" | "custom_credential"
      values: Record<string, string>
      connectionName?: string
    }) => rpc.connectorConnect(args.service, args.authType, args.values, args.connectionName),
    onSuccess: refreshConnections
  })
  const disconnectMutation = useMutation({
    mutationFn: (args: { service: string; connectionName?: string }) =>
      rpc.connectorDisconnect(args.service, args.connectionName),
    onSuccess: refreshConnections
  })
  const oauthConfigMutation = useMutation({
    mutationFn: (args: {
      provider: string
      clientId: string
      clientSecret: string
      extra?: Record<string, string>
    }) => rpc.connectorSetOauthConfig(args.provider, args.clientId, args.clientSecret, args.extra),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectorOauthKey })
  })
  const startOauthMutation = useMutation({
    mutationFn: (args: { service: string; connectionName?: string }) =>
      rpc.connectorStartOauth(args.service, args.connectionName),
    onSuccess: refreshConnections
  })

  const onConnect = useCallback(
    async (service: string, authType: "api_key" | "custom_credential", values: Record<string, string>) =>
      void (await connectMutation.mutateAsync({ service, authType, values })),
    [connectMutation]
  )
  const onDisconnect = useCallback(
    async (service: string) => void (await disconnectMutation.mutateAsync({ service })),
    [disconnectMutation]
  )
  const onSetOauthConfig = useCallback(
    async (provider: string, clientId: string, clientSecret: string) =>
      void (await oauthConfigMutation.mutateAsync({ provider, clientId, clientSecret })),
    [oauthConfigMutation]
  )
  const onStartOauth = useCallback(
    async (service: string) => void (await startOauthMutation.mutateAsync({ service })),
    [startOauthMutation]
  )

  const queryError = providersQuery.error ?? connectionsQuery.error ?? oauthQuery.error
  const error = !ready
    ? "Configure your OpenConnector endpoint and token in Settings › Unified MCP first."
    : queryError
      ? queryError.message ?? "Failed to reach OpenConnector."
      : null

  return {
    providers: providersQuery.data ?? [],
    connections: connectionsQuery.data ?? [],
    oauthConfigs: oauthQuery.data ?? [],
    loading: ready && (providersQuery.isLoading || connectionsQuery.isLoading),
    error,
    onConnect,
    onDisconnect,
    onSetOauthConfig,
    onStartOauth,
    onRefresh
  }
}
