/**
 * `@starbase/plugin-sdk` — the renderer half of a plugin.
 *
 * Import from here in the module your manifest names as `ui`. It is an ES
 * module loaded into Starbase's renderer over the `starbase-plugin://` scheme,
 * and it shares the app's React instance — which is why `react` is a peer
 * dependency you must NOT bundle. Bundling your own copy puts two Reacts in one
 * tree and every hook throws, but only once a second plugin is installed, so it
 * is a bug you will ship having genuinely tested.
 *
 * The build config in `./vite.js` sets the right externals for you.
 *
 * ## The shape of a plugin
 *
 * ```ts
 * import { defineManifest, definePlugin, useHost, type TabProps } from "@starbase/plugin-sdk"
 *
 * export const manifest = defineManifest({
 *   id: "linear",
 *   name: "Linear",
 *   version: "1.0.0",
 *   ui: "dist/ui.js",
 *   contributes: { tabs: [{ id: "linear.issues", label: "Issues", icon: "CircleDot" }] }
 * })
 *
 * function IssuesTab({ session }: TabProps) {
 *   const host = useHost()
 *   return <div className="p-4 text-text">Issues for {session.repo}</div>
 * }
 *
 * export default definePlugin(manifest, { views: { "linear.issues": IssuesTab } })
 * ```
 *
 * ## Two rules worth knowing before you start
 *
 * 1. **Never hardcode a colour.** Every colour in Starbase is a `--sb-*` custom
 *    property exposed to Tailwind as `bg-panel`, `text-blue`, `border-line`. A
 *    literal hex survives a theme switch unchanged, which on a light theme means
 *    white text on white. Your tab is themed for free if you use the tokens.
 * 2. **Bump `version` to reload.** ES module imports are cached by URL for the
 *    life of the window, so Starbase keys your module's URL by the manifest
 *    version. Editing a file without bumping it shows you the old module.
 *
 * @see AGENTS.md in this package — the full contract, written for a coding agent.
 * @see api-digest.md — every export with its signature, on one page.
 */

// The authoring calls. Everything else here is a type.
export { defineManifest, definePlugin } from "./define.js"

export type {
  ActivationEvent,
  CommandDeclaration,
  CommandIdsOf,
  ContributionId,
  IdOf,
  ManifestInput,
  PaneDeclaration,
  PaneIdsOf,
  PaneProps,
  Plugin,
  TabDeclaration,
  TabIdsOf,
  TabProps,
  TabVisibility
} from "./define.js"

export type { Disposable, PluginStorage, SessionSnapshot } from "./common.js"

export {
  useCommand,
  useHost,
  usePluginStorage,
  useSession,
  useSessionOrNull
} from "./hooks.js"
export type { HostBridge, PluginViewValue } from "./context.js"

/**
 * Starbase's own wiring. A plugin never imports these — the host uses them to
 * scope the hooks above to one rendered view.
 *
 * Exported from the public entrypoint rather than a private path because the
 * renderer resolves `@starbase/plugin-sdk` to this exact module, and plugins
 * resolve it to a shim over the same instance. One module, one context object;
 * a second copy would make `useContext` silently return null in every plugin.
 */
export { PluginViewContext, PluginViewProvider } from "./context.js"

// The themed UI kit is NOT re-exported here. It lives at
// `@starbase/plugin-sdk/ui`, for the same reason `/host` is separate: this entry
// has to stay importable from a plain Node script. A plugin generates its
// `starbase.plugin.json` by importing its own manifest module, which imports
// `defineManifest` from here — and re-exporting the UI kit made that script drag
// in the entire component library and die on a stylesheet import.
