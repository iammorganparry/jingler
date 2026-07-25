/**
 * The singletons a plugin's ES module imports.
 *
 * ## The problem this solves
 *
 * A plugin ships `import { useState } from "react"`. The importmap in
 * `index.html` points that bare specifier at
 * `starbase-plugin://runtime/react.js`, and the main process serves a generated
 * shim for it (`main/plugin-protocol.ts`). That shim does not contain React — it
 * reads `globalThis.__STARBASE_RUNTIME__` and re-exports off it.
 *
 * This module is what puts the object there.
 *
 * Serving the real library instead would give every plugin its own React
 * instance, and two Reacts in one tree makes every hook throw "invalid hook
 * call". The cruel part is WHEN it breaks: one plugin alone works fine, because
 * the app's React is the only one mounting. It fails the moment a second plugin
 * is installed — so an author would ship something they had genuinely tested.
 *
 * ## Import it for the side effect, first
 *
 * `main.tsx` imports this before `createRoot`. It must run before any plugin
 * module is evaluated; the shim throws a named error rather than yielding
 * `undefined` if that ordering is ever broken, so the failure names itself
 * instead of surfacing three frames into someone else's component.
 */
import * as React from "react"
import * as jsxRuntime from "react/jsx-runtime"

/** What the generated shims destructure. Keys match `RUNTIME_MODULES`. */
export interface StarbaseRuntime {
  readonly react: typeof React
  readonly jsxRuntime: typeof jsxRuntime
  /**
   * The plugin SDK's renderer half.
   *
   * Populated by `publishPluginSdk` rather than imported here, because the SDK
   * needs hooks that read this app's contexts — importing it at module scope
   * would make the dependency circular.
   */
  readonly sdk: Record<string, unknown>
}

declare global {
  // eslint-disable-next-line no-var
  var __STARBASE_RUNTIME__: StarbaseRuntime | undefined
}

const sdk: Record<string, unknown> = {}

/**
 * Publish the runtime. Idempotent, and safe to call before anything mounts.
 *
 * The `sdk` object is installed by reference and filled in later, so a plugin
 * that imported the SDK shim during boot still observes the finished surface —
 * replacing the object wholesale would leave early importers holding an empty
 * one.
 */
export const publishPluginRuntime = (): void => {
  globalThis.__STARBASE_RUNTIME__ ??= {
    react: React,
    jsxRuntime,
    sdk
  }
}

/**
 * Fill in the SDK surface plugins import as `@starbase/plugin-sdk`.
 *
 * Mutates in place — see the note on {@link publishPluginRuntime}.
 */
export const publishPluginSdk = (surface: Record<string, unknown>): void => {
  publishPluginRuntime()
  Object.assign(sdk, surface)
}

// Published on import, so `import "./plugin-runtime.js"` in main.tsx is enough
// and no caller can forget the call.
publishPluginRuntime()
