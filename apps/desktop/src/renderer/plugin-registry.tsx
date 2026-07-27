/**
 * The live plugin set, as React context.
 *
 * Owns one job: keep `~/starbase/plugins` on disk and the app's contributions in
 * sync, in both directions of change — a plugin added, edited, enabled, disabled
 * or removed. It subscribes to `Plugins.watch`, which re-emits the WHOLE catalog
 * on every change rather than a delta, so this file never accumulates state that
 * could drift out of step with disk.
 *
 * ## Why loading is keyed by id AND version
 *
 * ES module imports are cached by URL for the life of the realm. Re-importing an
 * edited plugin at the same URL returns the original module, so the author saves
 * a file and watches nothing happen. `pluginModuleUrl` puts the manifest version
 * in the query string and this file re-imports whenever that key changes — which
 * is why bumping `version` is the documented way to force a reload.
 *
 * ## Two queries, not two `useState`s
 *
 * Both halves are react-query, matching `use-theme.ts`: a catalog query the
 * watch stream seeds directly, and a module-loading query keyed by the plugin
 * set's id@version fingerprint. The second is a cache keyed on identity, which
 * is what react-query already is — so skipping a redundant re-import is the
 * default rather than a hand-written effect guard, in-flight loads dedupe, and
 * "loading" and "settled" stop being two pieces of state to keep in step.
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { PluginCatalog } from "@starbase/core"
import type { PaneContribution, PluginPaletteCommand, TabContribution } from "@starbase/ui"
import { rpc } from "./rpc-client.js"
import {
  loadPlugins,
  type ActivePlugin,
  type PluginLoadError
} from "./plugin-loader.js"
import { PluginActivateOnMount } from "./plugin-activate-on-mount.js"
import { PluginPaneHost } from "./plugin-pane-host.js"
import { PluginTabHost } from "./plugin-tab-host.js"

interface PluginRegistryValue {
  /** Tabs contributed by every enabled plugin that loaded, ready to merge. */
  readonly tabs: ReadonlyArray<TabContribution>
  /** Dock panes, mounted once for the window rather than per session pane. */
  readonly panes: ReadonlyArray<PaneContribution>
  /**
   * Commands contributed by plugins that LOADED, for the command palette.
   *
   * Derived from `loaded.active` rather than the catalog, which is the whole
   * point: a plugin whose module failed to import has no `commands.register`
   * handler behind its manifest entry, so listing its commands would offer rows
   * that dispatch into nothing.
   */
  readonly commands: ReadonlyArray<PluginPaletteCommand>
  /** Plugins that failed to load, for Settings to show verbatim. */
  readonly errors: ReadonlyArray<PluginLoadError>
  /** The last catalog from disk, including manifests that failed to decode. */
  readonly catalog: PluginCatalog | null
}

const EMPTY: PluginRegistryValue = {
  tabs: [],
  panes: [],
  commands: [],
  errors: [],
  catalog: null
}
const EMPTY_MODULES: {
  active: ReadonlyArray<ActivePlugin>
  errors: ReadonlyArray<PluginLoadError>
} = { active: [], errors: [] }

const PluginRegistryContext = createContext<PluginRegistryValue>(EMPTY)

export const pluginCatalogKey = ["plugins"] as const

/**
 * One stable key per loaded plugin set — see the note on versions above.
 *
 * This is the *query key* for the module-loading query, which is what makes
 * react-query do the memoisation: two catalogs that name the same plugins at
 * the same versions hit the same cache entry, so a watch re-emit that changed
 * nothing relevant (a disabled plugin's mtime, say) does not re-import every
 * module and remount every plugin tab under the operator.
 */
const catalogKey = (catalog: PluginCatalog | undefined): string =>
  (catalog?.plugins ?? [])
    .filter((p) => p.enabled)
    .map((p) => `${p.manifest.id}@${p.manifest.version}`)
    .join(",")

export function PluginProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  // The read at mount matters: `watch` only emits on CHANGE, so on its own the
  // app would show no plugins until the operator happened to touch the
  // directory.
  const { data: catalog } = useQuery({
    queryKey: pluginCatalogKey,
    queryFn: () => rpc.pluginsList(),
    // The catalog only changes through writes this app makes or through the
    // watch stream below, both of which seed the cache directly — the same
    // reasoning as the theme catalog. Refetching on focus would re-read every
    // manifest off disk each time the window is clicked, for a result already
    // known to be current.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false
  })

  useEffect(
    () =>
      rpc.pluginsWatch((next) => {
        // Seed rather than invalidate: the stream already carries the whole
        // catalog, so invalidating would round-trip for a payload we hold.
        queryClient.setQueryData(pluginCatalogKey, next)
      }),
    [queryClient]
  )

  /**
   * Importing the modules is its own query, keyed by id@version.
   *
   * A query rather than an effect because the work is a cache keyed on
   * identity, which is exactly what react-query is: re-importing is skipped for
   * free when the key is unchanged, in-flight loads are deduped, and the
   * "loading" and "settled" states stop being two `useState`s to keep in step.
   * It also removes the `exhaustive-deps` suppression the effect needed, since
   * the dependency is now the key itself rather than a value the linter cannot
   * see through.
   */
  const { data: loaded = EMPTY_MODULES } = useQuery({
    queryKey: ["plugin-modules", catalogKey(catalog)] as const,
    queryFn: () => loadPlugins(catalog?.plugins ?? []),
    enabled: catalog !== undefined,
    // `loadPlugins` never rejects — it partitions into active and errors — so a
    // retry could only repeat identical work.
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false
  })

  const value = useMemo<PluginRegistryValue>(() => {
    /**
     * The `activationEvents` each plugin declared, by id.
     *
     * Read from the catalog because `ActivePlugin` carries only what the loader
     * built — ids, versions, contributions — and the events live on the manifest.
     */
    const eventsFor = new Map(
      (catalog?.plugins ?? []).map((p) => [
        p.manifest.id,
        p.manifest.activationEvents ?? []
      ])
    )

    /**
     * `id@version`, the one string that changes when a plugin's CODE changes.
     *
     * The error boundaries use it to decide when a stale failure card should go.
     * They used to key that on the identity of the element passed as `children`,
     * which is rebuilt on every render — so a plugin that threw deterministically
     * was cleared and re-mounted on every tick of the session pane. Bumping
     * `version` is already the documented way to force a reload, so it is also
     * the honest signal for "this is a different build, try again".
     *
     * Read off `ActivePlugin`, which carries `version` already. An earlier
     * version built a Map from the catalog instead, which was both a needless
     * indirection and a lookup that could MISS — the loader can hold an active
     * plugin the catalog query has since stopped listing, and a miss fell back
     * to a bare id, silently turning the reset key into a constant.
     */
    const reloadKeyOf = (plugin: { id: string; version: string }) =>
      `${plugin.id}@${plugin.version}`

    const tabs = loaded.active.flatMap((plugin) =>
      plugin.tabs.map((tab) => ({
        ...tab,
        // Every plugin body is wrapped HERE rather than in the loader, so the
        // boundary is guaranteed present no matter who built the contribution.
        //
        // The activator sits OUTSIDE the boundary: dispatching an activation
        // event is the app's business, and a plugin whose render throws should
        // still have had its host half told the tab was opened — that is often
        // exactly the code that would fix the render.
        render: (session: Parameters<typeof tab.render>[0], ctx: Parameters<typeof tab.render>[1]) => (
          <PluginActivateOnMount
            pluginId={plugin.id}
            shouldActivate={(eventsFor.get(plugin.id) ?? []).includes(`onTab:${tab.id}`)}
          >
            <PluginTabHost
              pluginId={plugin.id}
              reloadKey={reloadKeyOf(plugin)}
              session={session}
            >
              {tab.render(session, ctx)}
            </PluginTabHost>
          </PluginActivateOnMount>
        )
      }))
    )
    // Panes get `PluginPaneHost`, not `PluginTabHost` — same job, nullable
    // session, dock-shaped failure copy. Wrapped HERE for the same reason tabs
    // are: the boundary is then guaranteed present no matter who built the
    // contribution.
    //
    // A previous version of this comment said a pane's boundary "comes with the
    // pane host in session-split". It did not: `renderDock` there is a bare
    // `<div>`, so nothing on the pane path had a boundary or a view provider —
    // one throwing pane blanked the window, and every SDK hook threw inside a
    // pane despite the SDK documenting them as working there.
    const panes = loaded.active.flatMap((plugin) =>
      plugin.panes.map((pane) => ({
        ...pane,
        render: (session: Parameters<typeof pane.render>[0]) => (
          <PluginPaneHost
            pluginId={plugin.id}
            reloadKey={reloadKeyOf(plugin)}
            session={session}
          >
            {pane.render(session)}
          </PluginPaneHost>
        )
      }))
    )

    /**
     * The palette entries a loaded plugin's manifest promised.
     *
     * Read off the CATALOG's manifests but gated on the loader's active set:
     * `ActivePlugin` carries only what the loader built (tabs, panes), the same
     * reason `eventsFor` above goes to the catalog for activation events.
     */
    const activeIds = new Set(loaded.active.map((p) => p.id))
    const commands: ReadonlyArray<PluginPaletteCommand> = (catalog?.plugins ?? [])
      .filter((p) => p.enabled && activeIds.has(p.manifest.id))
      .flatMap((p) =>
        (p.manifest.contributes?.commands ?? []).map((command) => ({
          pluginId: p.manifest.id,
          commandId: command.id,
          title: command.title,
          ...(command.category === undefined ? {} : { category: command.category }),
          pluginName: p.manifest.name
        }))
      )

    return {
      tabs,
      panes,
      commands,
      // Manifests that never decoded are failures too, and the operator should
      // see them in the same list as modules that failed to import.
      errors: [
        ...loaded.errors,
        ...(catalog?.failed ?? []).map((f) => ({ id: f.dir, message: f.message }))
      ],
      // `undefined` (not loaded yet) and a failed read both present as `null`
      // here. That collapse is deliberate: consumers only ever ask "what is
      // installed?", and "nothing yet" and "the read failed" both answer
      // "nothing to show" — a modal about a subsystem the operator may never
      // have used would be worse than an empty list.
      catalog: catalog ?? null
    }
  }, [loaded, catalog])

  return (
    <PluginRegistryContext.Provider value={value}>
      {children}
    </PluginRegistryContext.Provider>
  )
}

/** Every plugin-contributed tab, ready to hand to `SessionPane`. */
export const usePluginTabs = (): ReadonlyArray<TabContribution> =>
  useContext(PluginRegistryContext).tabs

/** Every plugin-contributed dock pane, for `SessionSplit`. */
export const usePluginPanes = (): ReadonlyArray<PaneContribution> =>
  useContext(PluginRegistryContext).panes

/** Every command a loaded plugin contributed, for the command palette. */
export const usePluginCommands = (): ReadonlyArray<PluginPaletteCommand> =>
  useContext(PluginRegistryContext).commands

/** Plugins that failed to load — manifest or module — for Settings. */
export const usePluginErrors = (): ReadonlyArray<PluginLoadError> =>
  useContext(PluginRegistryContext).errors

/** The raw catalog, for the Settings list. */
export const usePluginCatalog = (): PluginCatalog | null =>
  useContext(PluginRegistryContext).catalog
