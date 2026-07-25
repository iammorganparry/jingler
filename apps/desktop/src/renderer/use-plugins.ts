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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { PluginsSettingsProps } from "@starbase/ui"
import { rpc } from "./rpc-client.js"
import {
  pluginCatalogKey,
  usePluginCatalog,
  usePluginErrors
} from "./plugin-registry.js"

const authSessionsKey = ["plugin-auth-sessions"] as const

export function usePlugins(): PluginsSettingsProps {
  const catalog = usePluginCatalog()
  const loadErrors = usePluginErrors()
  const queryClient = useQueryClient()

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
    onSetEnabled: (pluginId, enabled) => setEnabled.mutateAsync({ pluginId, enabled }),
    onUninstall: (pluginId) => uninstall.mutateAsync(pluginId),
    onReveal: (pluginId) => rpc.pluginsReveal(pluginId),
    onRevokeAuth: (pluginId, providerId) =>
      revokeAuth.mutateAsync({ pluginId, providerId })
  }
}
