import type { McpServerStatus, OpenConnectorConfig, OpenConnectorDefaults } from "@jingler/core"
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

  /**
   * Keyed on `mutate`/`mutateAsync`, NOT the mutation object.
   *
   * React Query returns a NEW result object on every render, so depending on the
   * whole mutation made these callbacks change identity every render. `Settings ›
   * Connectors` probes in an effect keyed on `test`, and an unstable `test` turned
   * that into an unbounded probe loop that pinned the renderer — the window stopped
   * answering clicks entirely. The `mutate` functions themselves are stable.
   */
  const saveFn = saveMutation.mutateAsync
  const testFn = testMutation.mutate
  const autoSetupFn = autoSetupMutation.mutateAsync

  const save = useCallback(
    (config: OpenConnectorConfig, token?: string | null) => saveFn({ config, token }),
    [saveFn]
  )
  const test = useCallback(() => testFn(), [testFn])
  const autoSetup = useCallback(() => autoSetupFn(), [autoSetupFn])

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
