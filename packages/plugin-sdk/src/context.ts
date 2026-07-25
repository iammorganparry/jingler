/**
 * How a plugin hook knows which plugin is calling it.
 *
 * ## Why a React context and not a global
 *
 * The obvious implementation is a module-level "current plugin" that the host
 * sets before rendering a view. It is also wrong, and wrong in a way that only
 * shows up once someone splits the window: Starbase renders up to four session
 * panes at once, and two of them can be showing tabs from two different plugins
 * simultaneously. A global would hand both of them whichever plugin rendered
 * last, so `useHost()` in one plugin would invoke commands in another.
 *
 * A context is scoped to the subtree, which is exactly the scope the answer has.
 * It is also correct under concurrent rendering, where React may interleave work
 * on two subtrees — something no amount of care with a global can survive.
 *
 * ## Why this works across the plugin boundary at all
 *
 * A React context object is only meaningful to the React instance that created
 * it. That is fine here precisely because of the importmap: a plugin's `react`
 * specifier resolves to a shim re-exporting the app's React instance, and its
 * `@starbase/plugin-sdk` specifier resolves to a shim re-exporting the app's
 * copy of THIS module. One React, one context object, one SDK — which is the
 * same reason a plugin must never bundle its own React.
 */
import { createContext, createElement, type ReactNode } from "react"
import type { PluginStorage, SessionSnapshot } from "./common.js"

/** What a plugin's UI half can ask the app for. */
export interface HostBridge {
  /**
   * Run a command registered by this plugin's host half, and get its result.
   *
   * The only route from a plugin's UI to anything outside the renderer — the
   * network, a CLI, the filesystem. The renderer's CSP does not allow a plugin
   * to make requests directly, by design.
   *
   * @example
   * ```ts
   * const issues = await useHost().invoke<Issue[]>("linear.sync")
   * ```
   * @throws If the plugin has no host half, or the command is not registered.
   */
  invoke<T = unknown>(commandId: string, arg?: unknown): Promise<T>
  /** This plugin's private key/value store, shared with its host half. */
  readonly storage: PluginStorage
  /** Open a URL in the operator's real browser rather than inside the app. */
  openExternal(url: string): Promise<void>
}

/** Everything the hooks resolve, scoped to one rendered plugin view. */
export interface PluginViewValue {
  /** The plugin that owns the view being rendered. */
  readonly pluginId: string
  /** The session this view is decorating. */
  readonly session: SessionSnapshot
  /** This plugin's bridge to the app. */
  readonly bridge: HostBridge
}

/**
 * Null outside a plugin view, so the hooks can throw something that names the
 * mistake rather than reading a property off `undefined` three frames deep.
 */
export const PluginViewContext = createContext<PluginViewValue | null>(null)

/**
 * Wraps one plugin view. Starbase does this for you — a plugin never renders it.
 *
 * `createElement` rather than JSX so this module stays a plain `.ts` and the SDK
 * needs no JSX build step of its own.
 */
export const PluginViewProvider = ({
  value,
  children
}: {
  value: PluginViewValue
  children: ReactNode
}) => createElement(PluginViewContext.Provider, { value }, children)
