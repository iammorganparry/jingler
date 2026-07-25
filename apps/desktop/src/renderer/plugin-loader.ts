/**
 * Turning a decoded manifest into a mounted React contribution.
 *
 * ## The one rule
 *
 * A plugin is third-party code, loaded from a folder the operator dropped into
 * `~/starbase/plugins`, and it is imported into the renderer's own realm. Every
 * boundary in this file exists so that a plugin which is broken, half-written,
 * or actively hostile costs itself its tab and nothing else.
 *
 * Three things can go wrong and each is caught separately, because each needs a
 * different message:
 *
 * 1. **The module will not import** — a syntax error, a missing file, a bad
 *    relative path. Caught here.
 * 2. **The module imports but exports the wrong shape** — no default export, or
 *    a default that is not a plugin. Caught here, by validating against what the
 *    manifest CLAIMED. A plugin that declares a tab and ships no view for it is
 *    a load failure, not a blank tab at runtime.
 * 3. **A component throws while rendering.** Not caught here — that is
 *    `plugin-tab-host.tsx`'s error boundary, because by then React owns the
 *    call stack.
 *
 * ## Why the manifest is the source of truth
 *
 * The loader trusts the manifest's contribution list and checks the module
 * against it, not the other way round. A plugin cannot contribute a tab it did
 * not declare — otherwise the enable/disable switch in Settings would be
 * advisory, since a module could register whatever it liked at import time.
 */
import { createElement, type ComponentType } from "react"
import type { LoadedPlugin, Session } from "@starbase/core"
import {
  PLUGIN_TAB_ORDER,
  type TabContribution,
  type TabContext
} from "@starbase/ui"
import type { LucideIcon } from "lucide-react"
import * as Icons from "lucide-react"
import { Boxes } from "lucide-react"

/** What a plugin's UI module must default-export. */
export interface PluginModule {
  readonly views?: Record<string, ComponentType<PluginViewProps>>
}

/** What a plugin's view component is handed. */
export interface PluginViewProps {
  readonly session: Session
  readonly pluginId: string
}

/** A plugin that loaded, with the contributions it actually provided. */
export interface ActivePlugin {
  readonly id: string
  readonly version: string
  readonly tabs: ReadonlyArray<TabContribution>
}

/** A plugin that did not load, and why — surfaced in Settings verbatim. */
export interface PluginLoadError {
  readonly id: string
  readonly message: string
}

export type PluginLoadResult =
  | { readonly ok: true; readonly plugin: ActivePlugin }
  | { readonly ok: false; readonly error: PluginLoadError }

/**
 * Resolve a lucide icon by name, falling back rather than failing.
 *
 * A mistyped icon is a cosmetic mistake and must not cost the plugin its tab —
 * an unlabelled box is a legible "this plugin got something slightly wrong",
 * whereas refusing to load would make a one-character typo look like a crash.
 */
export const resolveIcon = (name: string | undefined): LucideIcon => {
  if (!name) return Boxes
  const found = (Icons as unknown as Record<string, unknown>)[name]
  return isComponent(found) ? (found as LucideIcon) : Boxes
}

/**
 * Is this value something React can render as a component?
 *
 * NOT `typeof x === "function"`. lucide-react's icons are `forwardRef` results,
 * which are OBJECTS carrying a `$$typeof` symbol — so a function-only check
 * rejects every real icon and silently falls back, putting a generic box on
 * every plugin tab in the app. The lucide barrel also exports non-component
 * values (the icon-node maps), so "not a function" is not enough on its own
 * either; both arms are load-bearing.
 */
const isComponent = (value: unknown): boolean =>
  typeof value === "function" ||
  (typeof value === "object" && value !== null && "$$typeof" in value)

/** The manifest's coarse visibility literal, as a predicate over a session. */
const visibilityPredicate = (
  when: string | undefined
): ((ctx: TabContext) => boolean) => {
  switch (when) {
    case "hasPr":
      return ({ session }) => session.prNumber != null
    case "hasWorktree":
      return ({ session }) => session.worktreePath != null
    case "hasIssue":
      return ({ session }) => session.issueNumber != null
    default:
      return () => true
  }
}

/**
 * The URL a plugin's UI module is imported from.
 *
 * The manifest version is in the query string on purpose: it is what makes hot
 * reload work. ES module imports are cached by URL for the life of the realm,
 * so re-importing the same path after an edit returns the ORIGINAL module and
 * the author sees their change do nothing. Bumping the version changes the URL
 * and forces a fresh evaluation.
 */
export const pluginModuleUrl = (plugin: LoadedPlugin): string =>
  `starbase-plugin://${plugin.manifest.id}/${(plugin.manifest.ui ?? "").replace(/^\.?\//, "")}?v=${encodeURIComponent(plugin.manifest.version)}`

/**
 * Import one plugin's UI module and build its contributions.
 *
 * Never throws. Every failure comes back as `{ ok: false }` carrying a message
 * written to be read by an operator in Settings, not by whoever wrote this file.
 */
export const loadPluginUi = async (
  plugin: LoadedPlugin,
  importer: (url: string) => Promise<unknown> = (url) =>
    import(/* @vite-ignore */ url)
): Promise<PluginLoadResult> => {
  const { manifest } = plugin
  const declaredTabs = manifest.contributes?.tabs ?? []

  // A plugin with no UI entry is legal — it may be host-only, or contribute
  // nothing yet. It simply has no tabs, which is not an error.
  if (!manifest.ui || declaredTabs.length === 0) {
    return { ok: true, plugin: { id: manifest.id, version: manifest.version, tabs: [] } }
  }

  let module: unknown
  try {
    module = await importer(pluginModuleUrl(plugin))
  } catch (cause) {
    return {
      ok: false,
      error: {
        id: manifest.id,
        message: `could not load ${manifest.ui}: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    }
  }

  const exported = (module as { default?: PluginModule } | undefined)?.default
  if (!exported || typeof exported !== "object") {
    return {
      ok: false,
      error: {
        id: manifest.id,
        message: `${manifest.ui} has no default export — a plugin's UI entry must \`export default definePlugin(...)\``
      }
    }
  }

  const views = exported.views ?? {}
  const tabs: Array<TabContribution> = []

  for (const declared of declaredTabs) {
    const view = views[declared.id]
    if (typeof view !== "function") {
      // Checked against the MANIFEST, so this fires at install time rather than
      // when the operator eventually clicks the tab and finds it empty.
      return {
        ok: false,
        error: {
          id: manifest.id,
          message: `declares the tab "${declared.id}" but its UI module exports no matching view`
        }
      }
    }

    const View = view
    tabs.push({
      id: declared.id,
      label: declared.label,
      icon: resolveIcon(declared.icon),
      order: declared.order ?? PLUGIN_TAB_ORDER,
      when: visibilityPredicate(declared.when),
      // `createElement` rather than JSX so this module stays a plain `.ts` —
      // it is a loader, and the one element it builds is not worth the syntax.
      render: (session) => createElement(View, { session, pluginId: manifest.id })
    })
  }

  return { ok: true, plugin: { id: manifest.id, version: manifest.version, tabs } }
}

/**
 * Load every enabled plugin in a catalog, concurrently.
 *
 * Concurrently and independently: one plugin taking two seconds to import must
 * not delay the other nine, and one failing must not abort the batch. The result
 * is partitioned rather than thrown so the caller renders what worked and
 * reports what did not, in the same pass.
 */
export const loadPlugins = async (
  plugins: ReadonlyArray<LoadedPlugin>,
  importer?: (url: string) => Promise<unknown>
): Promise<{
  active: ReadonlyArray<ActivePlugin>
  errors: ReadonlyArray<PluginLoadError>
}> => {
  const results = await Promise.all(
    plugins.filter((p) => p.enabled).map((p) => loadPluginUi(p, importer))
  )
  return {
    active: results.flatMap((r) => (r.ok ? [r.plugin] : [])),
    errors: results.flatMap((r) => (r.ok ? [] : [r.error]))
  }
}
