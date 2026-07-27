/**
 * `defineManifest` and `definePlugin` — the two calls a plugin author writes.
 *
 * ## What these buy over a plain object literal
 *
 * Nothing at runtime: both return their input untouched. Everything they do is
 * in the type system, and it is aimed at one failure mode.
 *
 * A plugin declares its tabs in `jingler.plugin.json` AND implements them in
 * its UI module. Those two lists have to agree, and nothing about writing them
 * separately makes them agree — declare `linear.issues`, export a view called
 * `linear.issue`, and the app loads, the tab appears, and clicking it shows an
 * empty pane. The manifest is data, the module is code, and the mismatch is
 * invisible to both.
 *
 * So the manifest is written in TypeScript through {@link defineManifest}, its
 * contribution ids are captured as literal types, and {@link definePlugin}
 * demands exactly those ids as the keys of `views`. Forget one and it is a
 * compile error naming the id. Add one that was never declared and it is a
 * compile error too — because a plugin that could register an undeclared
 * contribution would make the enable switch in Settings advisory.
 *
 * ## Why `const` type parameters
 *
 * Without `const`, TypeScript widens `id: "linear.issues"` to `string` the
 * moment it lands in an array, and every guarantee here collapses to
 * `Record<string, Component>` — which accepts anything. The `const` modifier
 * (TS 5.0+) keeps the literal, and it is the single load-bearing keyword in
 * this file.
 *
 * @see AGENTS.md in this package for the worked end-to-end example.
 */
import type { ComponentType } from "react"
import type { SessionSnapshot } from "./common.js"

// ── What a manifest looks like, in TypeScript ────────────────────────────────

/** When a tab should appear. Mirrors `TabVisibility` in `@jingler/core`. */
export type TabVisibility = "always" | "hasPr" | "hasWorktree" | "hasIssue"

/** One tab a plugin adds to the session pane. */
export interface TabDeclaration {
  /**
   * Namespaced `<pluginId>.<local>`, e.g. `linear.issues`.
   *
   * Two plugins both wanting a tab called `issues` is the expected case, not the
   * exotic one — the namespace is what stops the second silently shadowing the
   * first.
   */
  readonly id: string
  /** The tab bar label, e.g. `"Issues"`. */
  readonly label: string
  /** A lucide icon name, e.g. `"CircleDot"`. Unknown names fall back to a box. */
  readonly icon?: string
  /** Lower sorts earlier. Built-ins occupy 0–99; plugins default to 100. */
  readonly order?: number
  /** Which sessions get this tab. Defaults to `"always"`. */
  readonly when?: TabVisibility
}

/** One entry in the command palette. */
export interface CommandDeclaration {
  readonly id: string
  readonly title: string
  readonly category?: string
  readonly icon?: string
}

/** A dock pane, mounted once for the window beside the terminal. */
export interface PaneDeclaration {
  readonly id: string
  readonly label: string
  readonly icon?: string
  readonly slot: "right" | "bottom"
  readonly defaultSize?: number
}

/**
 * What wakes a dormant plugin's host half.
 *
 * Omit it entirely for a UI-only plugin: its tabs still render and no Node
 * process is ever started on its behalf.
 */
export type ActivationEvent =
  | "onStartupFinished"
  | `onCommand:${string}`
  | `onTab:${string}`
  | `repoContains:${string}`

/** The manifest shape, before id capture. */
export interface ManifestInput {
  /** Lowercase kebab-case, and the directory name under `~/jingler/plugins`. */
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly publisher?: string
  /**
   * The Jingler plugin API generation you built against — see
   * `PLUGIN_API_VERSION`, currently **1**.
   *
   * Optional, and worth setting. A Jingler older than your plugin refuses it at
   * load with a sentence saying so; without this field the same mismatch is a
   * stack trace from inside your bundle, on someone else's machine.
   *
   * A single integer rather than a semver range: the only useful answers are
   * "this host speaks your API" and "it does not". Only breaking changes to what
   * a plugin sees bump it, so a new hook or contribution point never will.
   */
  readonly apiVersion?: number
  /** ESM entry for the renderer half, relative to the plugin directory. */
  readonly ui?: string
  /** Entry for the extension-host half, relative to the plugin directory. */
  readonly main?: string
  readonly activationEvents?: readonly ActivationEvent[]
  readonly extensionDependencies?: readonly string[]
  readonly contributes?: {
    readonly tabs?: readonly TabDeclaration[]
    readonly panes?: readonly PaneDeclaration[]
    readonly commands?: readonly CommandDeclaration[]
  }
}

// ── Extracting the literal ids back out ──────────────────────────────────────

/** The tab ids a manifest declares, as a union of string literals. */
export type TabIdsOf<M> = M extends {
  contributes?: { tabs?: infer T }
}
  ? T extends readonly { readonly id: infer Id }[]
    ? Id & string
    : never
  : never

/** The dock-pane ids a manifest declares, as a union of string literals. */
export type PaneIdsOf<M> = M extends {
  contributes?: { panes?: infer P }
}
  ? P extends readonly { readonly id: infer Id }[]
    ? Id & string
    : never
  : never

/** The command ids a manifest declares, as a union of string literals. */
export type CommandIdsOf<M> = M extends {
  contributes?: { commands?: infer C }
}
  ? C extends readonly { readonly id: infer Id }[]
    ? Id & string
    : never
  : never

/** A plugin's own id, as a literal. */
export type IdOf<M> = M extends { readonly id: infer Id extends string } ? Id : never

/**
 * The namespace every one of a plugin's contribution ids must sit under.
 *
 * Surfacing this as an exported type is what makes an editor offer
 * `"linear."` as you type an id, rather than accepting any string and failing
 * at load.
 */
export type ContributionId<M> = `${IdOf<M>}.${string}`

/**
 * Carries a compile error when any contribution id is not namespaced under the
 * plugin's own id.
 *
 * Implemented as an intersection with an impossible property rather than a
 * `never` return, because a `never` gives "Type X is not assignable to never" —
 * true, unhelpful, and no indication of which id is wrong. This way the error
 * text contains the required prefix.
 */
type NamespaceCheck<M> =
  [TabIdsOf<M> | PaneIdsOf<M> | CommandIdsOf<M>] extends [never]
    ? unknown
    : TabIdsOf<M> | PaneIdsOf<M> | CommandIdsOf<M> extends ContributionId<M>
      ? unknown
      : {
          readonly __jingler_error: `every contribution id must start with "${IdOf<M>}."`
        }

// ── The two calls ────────────────────────────────────────────────────────────

/**
 * Declare a plugin's manifest with its ids captured as literal types.
 *
 * Returns its input unchanged — the value is exactly what belongs in
 * `jingler.plugin.json`, so the usual arrangement is to generate the JSON from
 * this at build time and keep one source of truth.
 *
 * @example
 * ```ts
 * export const manifest = defineManifest({
 *   id: "linear",
 *   name: "Linear",
 *   version: "1.0.0",
 *   ui: "dist/ui.js",
 *   activationEvents: ["onTab:linear.issues"],
 *   contributes: {
 *     tabs: [{ id: "linear.issues", label: "Issues", icon: "CircleDot" }]
 *   }
 * })
 * ```
 *
 * @example An id outside the plugin's own namespace is rejected:
 * ```ts
 * defineManifest({
 *   id: "linear",
 *   name: "Linear",
 *   version: "1.0.0",
 *   // Error: every contribution id must start with "linear."
 *   contributes: { tabs: [{ id: "jira.issues", label: "Issues" }] }
 * })
 * ```
 *
 * @see definePlugin — binds views to the ids captured here.
 */
export function defineManifest<const M extends ManifestInput>(
  manifest: M & NamespaceCheck<M>
): M {
  return manifest as M
}

/** What a plugin's tab component is handed. */
export interface TabProps {
  /** The session this tab is decorating. */
  readonly session: SessionSnapshot
  /** The id of the plugin this view belongs to. */
  readonly pluginId: string
}

/**
 * What a plugin's dock-pane component is handed.
 *
 * `session` is nullable and a tab's is not, because the two are mounted at
 * different scopes: a tab belongs to one session and cannot exist without it,
 * while a dock pane is mounted once for the WINDOW and follows whichever session
 * has focus — including none, when the last one is closed. A pane must therefore
 * be able to render an empty state.
 */
export interface PaneProps {
  /** The focused session, or `null` when no session is open. */
  readonly session: SessionSnapshot | null
  /** The id of the plugin this pane belongs to. */
  readonly pluginId: string
}

/** What a plugin's UI module default-exports. */
export interface Plugin<M extends ManifestInput = ManifestInput> {
  readonly manifest: M
  readonly views: Readonly<Record<string, ComponentType<TabProps>>>
  readonly panes: Readonly<Record<string, ComponentType<PaneProps>>>
}

/**
 * `views` is required when the manifest declares tabs and forbidden-ish (an
 * optional empty object) when it does not.
 *
 * Without the conditional, a pane-only plugin still had to write `views: {}` to
 * satisfy the type — which reads as "this plugin has no tabs, and I had to say so
 * twice". The same shape applies to `panes` below.
 */
type ViewsFor<M> = [TabIdsOf<M>] extends [never]
  ? { readonly views?: Readonly<Record<never, never>> }
  : { readonly views: { readonly [K in TabIdsOf<M>]: ComponentType<TabProps> } }

type PanesFor<M> = [PaneIdsOf<M>] extends [never]
  ? { readonly panes?: Readonly<Record<never, never>> }
  : { readonly panes: { readonly [K in PaneIdsOf<M>]: ComponentType<PaneProps> } }

/**
 * Bind components to the tabs and dock panes a manifest declares.
 *
 * Every declared id must appear, and no key outside the manifest is allowed.
 * Both directions are enforced at compile time, for tabs and panes alike.
 *
 * ## Panes were missing here, and that made them unbuildable
 *
 * The manifest schema accepted `contributes.panes`, the loader read a `panes`
 * key off the default export, the registry collected them and `SessionSplit`
 * mounted them. This function — the only supported way to produce that export —
 * had no `panes` parameter and never set the key. So the documented "plugins add
 * tabs, dock panes and commands" was two-thirds true: declaring a pane got you a
 * load error saying its UI module exports no matching pane component, which was
 * accurate and impossible to act on.
 *
 * @example
 * ```ts
 * import { defineManifest, definePlugin, type TabProps } from "@jingler/plugin-sdk"
 *
 * const manifest = defineManifest({
 *   id: "linear", name: "Linear", version: "1.0.0", ui: "dist/ui.js",
 *   contributes: { tabs: [{ id: "linear.issues", label: "Issues" }] }
 * })
 *
 * function IssuesTab({ session }: TabProps) {
 *   return <div>Issues for {session.repo}</div>
 * }
 *
 * export default definePlugin(manifest, {
 *   views: { "linear.issues": IssuesTab }
 * })
 * ```
 *
 * @example A dock pane. Note `session` may be `null` — a pane outlives any one
 * session, so it has to render an empty state.
 * ```ts
 * const manifest = defineManifest({
 *   id: "linear", name: "Linear", version: "1.0.0", ui: "dist/ui.js",
 *   contributes: { panes: [{ id: "linear.activity", label: "Activity", slot: "right" }] }
 * })
 *
 * function Activity({ session }: PaneProps) {
 *   if (!session) return <div>No session selected.</div>
 *   return <div>Activity for {session.repo}</div>
 * }
 *
 * export default definePlugin(manifest, { panes: { "linear.activity": Activity } })
 * ```
 *
 * @example Forgetting a declared tab fails to compile:
 * ```ts
 * // Error: Property '"linear.issues"' is missing in type '{}'
 * export default definePlugin(manifest, { views: {} })
 * ```
 *
 * @returns The value the UI module must `export default`.
 */
export function definePlugin<const M extends ManifestInput>(
  manifest: M,
  impl: ViewsFor<M> & PanesFor<M>
): Plugin<M> {
  const { views, panes } = impl as {
    views?: Record<string, ComponentType<TabProps>>
    panes?: Record<string, ComponentType<PaneProps>>
  }
  // Both default to `{}` rather than being left undefined: the loader iterates
  // the manifest's declarations and indexes into these, and an absent object
  // would turn a "you declared a pane with no component" load error into a
  // TypeError inside the renderer.
  return { manifest, views: views ?? {}, panes: panes ?? {} }
}
