/**
 * What Settings › Plugins needs, assembled from the two places it lives.
 *
 * The catalog and the module-load errors come from `PluginProvider` — already
 * live, already keyed, already subscribed to the watch stream — so this hook
 * reads them from context rather than fetching again. Granted auth sessions are
 * their own query because nothing else in the app displays them.
 *
 * Mutations invalidate rather than seed: unlike the watch stream, which carries
 * the whole catalog, `setEnabled` and friends return nothing useful, and the
 * authoritative answer is the next catalog emission from disk.
 */
import { useCallback, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { PluginsSettingsProps } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import {
  pluginCatalogKey,
  usePluginCatalog,
  usePluginErrors
} from "./plugin-registry.js"

const authSessionsKey = ["plugin-auth-sessions"] as const

/**
 * The operator-facing sentence from a failed RPC.
 *
 * `PluginError` crosses the boundary as a tagged error carrying `reason`, which
 * is already written to be read — "No jingler.plugin.json in the selected
 * folder." The `message` fallback catches anything else, and the last resort
 * exists because a rejection with neither is still a rejection the operator
 * deserves to know happened.
 */
const reasonOf = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    const maybe = cause as { reason?: unknown; message?: unknown }
    if (typeof maybe.reason === "string" && maybe.reason.length > 0) return maybe.reason
    if (typeof maybe.message === "string" && maybe.message.length > 0) return maybe.message
  }
  return "That did not work, and the reason was not reported."
}

export function usePlugins(): PluginsSettingsProps {
  const catalog = usePluginCatalog()
  const loadErrors = usePluginErrors()
  const queryClient = useQueryClient()

  /**
   * Why the last action failed.
   *
   * One slot rather than per-mutation error state: the operator performs one of
   * these at a time, and a newer failure supersedes an older one. Held here
   * rather than read off `mutation.error` because four mutations would give four
   * independent errors with no ordering between them, and the pane shows one
   * message.
   */
  const [actionError, setActionError] = useState<string | null>(null)
  const dismiss = useCallback(() => setActionError(null), [])

  /**
   * Run a mutation and route its rejection to the pane instead of the void.
   *
   * `PluginsSettings` invokes these as `void onX()`, so a rejection had nowhere
   * to go and became an unhandled promise rejection in devtools. Resolving after
   * catching is deliberate: the caller's `void` wants a settled promise, and the
   * error is now on screen rather than thrown past it.
   */
  const reporting = <A>(run: () => Promise<A>) => async (): Promise<void> => {
    setActionError(null)
    try {
      await run()
    } catch (cause) {
      setActionError(reasonOf(cause))
    }
  }

  const { data: authSessions = [] } = useQuery({
    queryKey: authSessionsKey,
    queryFn: () => rpc.pluginsAuthSessions()
  })

  // The watcher re-emits the catalog whenever the directory changes, which
  // covers enable/disable (it rewrites config.json) and uninstall (it removes a
  // directory). Invalidating as well is belt-and-braces for the case where a
  // write lands without touching a watched path.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: pluginCatalogKey })
  }

  const setEnabled = useMutation({
    mutationFn: ({ pluginId, enabled }: { pluginId: string; enabled: boolean }) =>
      rpc.pluginsSetEnabled(pluginId, enabled),
    onSettled: refresh
  })

  const uninstall = useMutation({
    mutationFn: (pluginId: string) => rpc.pluginsUninstall(pluginId),
    onSettled: refresh
  })

  // Without this the "Install from folder…" button in `PluginsSettings` never
  // rendered at all: the component only draws it when `onInstallFromFolder` is
  // provided, and this hook — the only caller — did not provide it. The RPC, the
  // service and the button all existed; the one line joining them did not, so the
  // documented install path was reachable only from a devtools console.
  const installFromPicker = useMutation({
    mutationFn: () => rpc.pluginsInstallFromPicker(),
    onSettled: refresh
  })

  const revokeAuth = useMutation({
    mutationFn: ({ pluginId, providerId }: { pluginId: string; providerId: string }) =>
      rpc.pluginsAuthRevoke(pluginId, providerId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: authSessionsKey })
    }
  })

  return {
    catalog,
    loadErrors,
    authSessions,
    actionError,
    onDismissActionError: dismiss,
    onSetEnabled: (pluginId, enabled) =>
      reporting(() => setEnabled.mutateAsync({ pluginId, enabled }))(),
    onUninstall: (pluginId) => reporting(() => uninstall.mutateAsync(pluginId))(),
    onInstallFromFolder: reporting(() => installFromPicker.mutateAsync()),
    onReveal: (pluginId) => reporting(() => rpc.pluginsReveal(pluginId))(),
    onRevokeAuth: (pluginId, providerId) =>
      reporting(() => revokeAuth.mutateAsync({ pluginId, providerId }))()
  }
}
