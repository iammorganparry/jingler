import type { McpServerStatus, OpenConnectorConfig, OpenConnectorDefaults } from "@starbase/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { rpc } from "./rpc-client.js"

/**
 * The unified OpenConnector settings for the Settings panel.
 *
 * `config` + `hasToken` come from one cheap read; the token itself never crosses
 * the bridge, so the panel shows "configured" without ever holding the secret. The
 * `Test` button drives a live probe on demand (like `useMcp`'s status query) rather
 * than on mount, since probing hits the network.
 */

export const openConnectorKey = ["open-connector"] as const

export interface OpenConnectorState {
  readonly config: OpenConnectorConfig | undefined
  readonly hasToken: boolean
  /** Env-aware onboarding defaults (dev = local instance, prod = hosted). */
  readonly defaults: OpenConnectorDefaults | undefined
  readonly loading: boolean
  /** Persist settings, and optionally a new token (undefined keeps, null/"" clears). */
  readonly save: (config: OpenConnectorConfig, token?: string | null) => Promise<void>
  /** One-click onboarding: apply the environment default. */
  readonly autoSetup: () => Promise<void>
  readonly settingUp: boolean
  /** The most recent probe result, or null until Test is pressed. */
  readonly status: McpServerStatus | null
  readonly testing: boolean
  readonly test: () => void
}

export function useOpenConnector(): OpenConnectorState {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<McpServerStatus | null>(null)

  const query = useQuery({
    queryKey: openConnectorKey,
    queryFn: () => rpc.openConnectorGet(),
    staleTime: Infinity
  })

  const saveMutation = useMutation({
    mutationFn: ({ config, token }: { config: OpenConnectorConfig; token?: string | null }) =>
      rpc.openConnectorSet(config, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: openConnectorKey })
  })

  const testMutation = useMutation({
    mutationFn: () => rpc.openConnectorTest(),
    onSuccess: (result) => setStatus(result)
  })

  const autoSetupMutation = useMutation({
    mutationFn: () => rpc.openConnectorAutoSetup(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: openConnectorKey })
  })

  const save = useCallback(
    (config: OpenConnectorConfig, token?: string | null) =>
      saveMutation.mutateAsync({ config, token }),
    [saveMutation]
  )
  const test = useCallback(() => testMutation.mutate(), [testMutation])
  const autoSetup = useCallback(() => autoSetupMutation.mutateAsync(), [autoSetupMutation])

  return {
    config: query.data?.config,
    hasToken: query.data?.hasToken ?? false,
    defaults: query.data?.defaults,
    loading: query.isLoading,
    save,
    autoSetup,
    settingUp: autoSetupMutation.isPending,
    status,
    testing: testMutation.isPending,
    test
  }
}
