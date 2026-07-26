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
import { useSession, type SessionSnapshot } from "@starbase/plugin-sdk"
import {
  PLUGIN_TAB_ORDER,
  type PaneContribution,
  type TabContribution,
  type TabContext
} from "@starbase/ui"
import type { LucideIcon } from "lucide-react"
import * as Icons from "lucide-react"
import { Boxes } from "lucide-react"

/** What a plugin's UI module must default-export. */
export interface PluginModule {
  readonly views?: Record<string, ComponentType<PluginViewProps>>
  /**
   * Dock pane components, keyed by contributed pane id.
   *
   * Separate from `views` because a pane's lifecycle is different: it is mounted
   * once for the WINDOW and takes whichever session has focus, where a tab
   * belongs to one session and there may be four on screen.
   */
  readonly panes?: Record<string, ComponentType<PluginPaneProps>>
}

/** What a plugin's dock pane component is handed. */
export interface PluginPaneProps {
  /** The focused session, or null when there is none. A dock outlives any one. */
  readonly session: SessionSnapshot | null
  readonly pluginId: string
}

/** What a plugin's view component is handed. */
export interface PluginViewProps {
  readonly session: SessionSnapshot
  readonly pluginId: string
}

/**
 * Narrow an internal `Session` to the subset a plugin may see.
 *
 * Starbase's `Session` carries ~25 fields — cost meters, token accounting, chat
 * arrays, worktree bookkeeping — and handing the whole thing to third-party code
 * would make every one of them a de-facto public API that cannot be reshaped
 * without breaking plugins. `SessionSnapshot` is the deliberately small, stable
 * subset the SDK documents, and this function is the only place the two meet.
 *
 * Built field-by-field rather than spread-and-omit on purpose: a new field added
 * to `Session` should NOT silently become visible to plugins, and a spread would
 * make it so.
 */
export const toSessionSnapshot = (session: Session): SessionSnapshot => ({
  id: session.id,
  repo: session.repo,
  branch: session.branch,
  title: session.title,
  cli: session.cli,
  prNumber: session.prNumber ?? null,
  ...(session.issueNumber != null ? { issueNumber: session.issueNumber } : {}),
  ...(session.worktreePath != null ? { worktreePath: session.worktreePath } : {})
})

/** A plugin that loaded, with the contributions it actually provided. */
export interface ActivePlugin {
  readonly id: string
  readonly version: string
  readonly tabs: ReadonlyArray<TabContribution>
  readonly panes: ReadonlyArray<PaneContribution>
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
 * Renders a plugin's view with the props the SDK documents.
 *
 * Exists so the snapshot is read from context rather than threaded through the
 * contribution's `render` argument — see the note at the call site.
 */
const PluginViewMount = ({
  View,
  pluginId
}: {
  View: ComponentType<PluginViewProps>
  pluginId: string
}) => createElement(View, { session: useSession(), pluginId })

/** Renders a plugin's dock pane, narrowing the session it is handed. */
const PluginPaneMount = ({
  Pane,
  pluginId,
  session
}: {
  Pane: ComponentType<PluginPaneProps>
  pluginId: string
  session: Session | null
}) =>
  createElement(Pane, {
    session: session ? toSessionSnapshot(session) : null,
    pluginId
  })

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

  const declaredPanes = manifest.contributes?.panes ?? []

  // Keybindings and settings are accepted by the manifest schema and consumed by
  // nothing. Rather than let a plugin declare one and watch it never happen —
  // the exact "silently absent" failure this loader exists to prevent — say so
  // at load time, in Settings, where the author will see it.
  //
  // `resolveKeybindings` and the settings form exist and are tested; what is
  // missing is the app-level dispatch to hook them to. Until that lands this is
  // the honest answer.
  const unsupported = [
    (manifest.contributes?.keybindings?.length ?? 0) > 0 ? "keybindings" : null,
    (manifest.contributes?.settings?.length ?? 0) > 0 ? "settings" : null
  ].filter((x): x is string => x !== null)

  if (unsupported.length > 0) {
    return {
      ok: false,
      error: {
        id: manifest.id,
        message: `contributes.${unsupported.join(" and contributes.")} — not supported in this build. Remove ${unsupported.length > 1 ? "them" : "it"} from the manifest; tabs, panes and commands work.`
      }
    }
  }

  // A plugin with no UI entry is legal — it may be host-only, or contribute
  // nothing yet. It simply has no tabs or panes, which is not an error.
  if (!manifest.ui || (declaredTabs.length === 0 && declaredPanes.length === 0)) {
    return {
      ok: true,
      plugin: { id: manifest.id, version: manifest.version, tabs: [], panes: [] }
    }
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
      // The session comes from context, not from this argument. `PluginTabHost`
      // wraps every plugin body and is the one place an internal `Session` is
      // narrowed to a `SessionSnapshot`; taking it from the argument here would
      // mean converting twice and, worse, leaving two definitions of what a
      // plugin can see.
      //
      // `createElement` rather than JSX so this module stays a plain `.ts` — it
      // is a loader, and the one element it builds is not worth the syntax.
      render: () => createElement(PluginViewMount, { View, pluginId: manifest.id })
    })
  }

  const panes: Array<PaneContribution> = []
  const paneComponents = exported.panes ?? {}

  for (const declared of declaredPanes) {
    const view = paneComponents[declared.id]
    if (typeof view !== "function") {
      // Checked exactly as tabs are. A declared pane with no component used to
      // be accepted and then silently dropped — the operator saw a contribution
      // count in Settings and nothing in the dock.
      return {
        ok: false,
        error: {
          id: manifest.id,
          message: `declares the pane "${declared.id}" but its UI module exports no matching pane component`
        }
      }
    }

    const Pane = view
    panes.push({
      id: declared.id,
      label: declared.label,
      icon: resolveIcon(declared.icon),
      slot: declared.slot,
      ...(declared.defaultSize === undefined ? {} : { defaultSize: declared.defaultSize }),
      render: (session) =>
        createElement(PluginPaneMount, { Pane, pluginId: manifest.id, session })
    })
  }

  return { ok: true, plugin: { id: manifest.id, version: manifest.version, tabs, panes } }
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
