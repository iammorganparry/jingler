import type { CliKind, McpInjectionTarget, OpenConnectorConfig } from "@starbase/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { rpc } from "./rpc-client.js"
import { openConnectorKey } from "./use-open-connector.js"

/**
 * Which harnesses actually receive the unified server — and the switch to change it.
 *
 * Read from `OpenConnector.injection` rather than derived here: the renderer has
 * the config and could compute a guess, but a guess is what made "connected" and
 * "the agent has the tools" look like the same thing. The main process answers with
 * the resolver the agent runner itself calls.
 *
 * Keyed on the same query key as the settings read, so saving the endpoint, the
 * token or a per-harness opt-out re-answers this with no refresh.
 */
export const injectionKey = ["open-connector", "injection"] as const

export interface InjectionTargetsState {
  readonly targets: ReadonlyArray<McpInjectionTarget>
  readonly loading: boolean
  readonly setEnabled: (cli: CliKind, enabled: boolean) => void
}

export function useInjectionTargets(config: OpenConnectorConfig | undefined): InjectionTargetsState {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: injectionKey,
    queryFn: () => rpc.openConnectorInjection()
  })

  const toggle = useMutation({
    mutationFn: ({ cli, enabled }: { cli: CliKind; enabled: boolean }) => {
      if (config === undefined) return Promise.resolve()
      /**
       * Written as an explicit boolean per harness rather than by deleting the key.
       * `perCli` treats an ABSENT harness as enabled, so an explicit `true` and a
       * missing entry mean the same thing today — but recording the operator's
       * answer keeps it stable if that default ever flips.
       */
      const perCli = { ...(config.perCli ?? {}), [cli]: enabled }
      return rpc.openConnectorSet({ ...config, perCli })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: openConnectorKey })
      await queryClient.invalidateQueries({ queryKey: injectionKey })
    }
  })

  // Keyed on `mutate`, not the mutation object: React Query returns a new result
  // object every render, and a callback that changes identity every render has
  // already cost this panel one runaway effect loop (see `ConnectorsSettings`).
  const toggleFn = toggle.mutate
  const setEnabled = useCallback(
    (cli: CliKind, enabled: boolean) => toggleFn({ cli, enabled }),
    [toggleFn]
  )

  return {
    targets: query.data ?? [],
    loading: query.isLoading,
    setEnabled
  }
}
