/**
 * What a plugin's UI half is allowed to ask the app for.
 *
 * ## Why every call carries a plugin id the plugin never supplies
 *
 * The id is closed over here, not passed by the caller. A plugin holds a bridge
 * that can only reach its own commands and its own storage, and there is no
 * argument it could pass to reach another's — the scoping is structural rather
 * than checked. That matters because plugin code runs in the renderer's own
 * realm: any check that a plugin could route around is decoration.
 *
 * ## Why bridges are cached
 *
 * One object per plugin, reused for the life of the window. `useCommand`
 * memoises on the bridge's identity, so a fresh object per render would hand
 * every consumer a new callback each time and defeat every dependency array
 * downstream.
 */
import type { HostBridge, PluginStorage, SessionActions } from "@starbase/plugin-sdk"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"

/**
 * Session mutations, published back into the app's own state.
 *
 * The RPC returns the updated record and `publishSessionUpdate` is how a write
 * made outside the view tree reaches `appMachine` — App.tsx already subscribes.
 * Without that call the write would land on disk and the sidebar would keep
 * rendering the pre-write session until the app restarted, which is the exact
 * failure `session-updates.ts` was written for.
 *
 * Not closed over a plugin id: unlike `invoke` and `storage`, this reaches the
 * app's own state rather than the plugin's, so there is nothing to scope. The
 * `sessionId` is the caller's, and any plugin can name any session — see the
 * note on `SessionActions` in the SDK for why that is an accepted risk here and
 * would not be for anything less reversible.
 */
const sessionActions: SessionActions = {
  unlinkIssue: async (sessionId: string) => {
    const session = await rpc.sessionsUnlinkIssue(sessionId)
    publishSessionUpdate(session)
  }
}

const bridges = new Map<string, HostBridge>()

const storageFor = (pluginId: string): PluginStorage => ({
  get: async <T,>(key: string) => {
    const value = await rpc.pluginsStorageGet(pluginId, key)
    // The RPC answers `null` for "never set" because that is what survives JSON.
    // The SDK promises `undefined`, which is what a JS caller expects from a
    // missing key — `?? undefined` is the whole of the translation.
    return (value ?? undefined) as T | undefined
  },
  set: (key: string, value: unknown) => rpc.pluginsStorageSet(pluginId, key, value),
  delete: (key: string) => rpc.pluginsStorageDelete(pluginId, key),
  keys: () => rpc.pluginsStorageKeys(pluginId)
})

/** The bridge for one plugin. Stable across renders. */
export const pluginBridge = (pluginId: string): HostBridge => {
  const existing = bridges.get(pluginId)
  if (existing) return existing

  const bridge: HostBridge = {
    invoke: <T,>(commandId: string, arg?: unknown) =>
      rpc.pluginsInvoke(pluginId, commandId, arg) as Promise<T>,
    storage: storageFor(pluginId),
    openExternal: async (url: string) => {
      // Guarded here as well as in main. A plugin passing `file:///…` or a
      // custom scheme would otherwise be asking the OS to open something the
      // operator never chose, and "the main process checks it" is a poor answer
      // when the check is one call away from the untrusted caller.
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`openExternal refused a non-http(s) URL: ${url}`)
      }
      await window.starbase.openExternal(url)
    },
    // Shared, not per-plugin: it carries no plugin-scoped state, and a fresh
    // object per bridge would only give `useSessionActions` a new identity in
    // every plugin for no gain.
    sessions: sessionActions
  }

  bridges.set(pluginId, bridge)
  return bridge
}
