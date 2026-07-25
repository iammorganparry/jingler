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
import * as sdkModule from "@starbase/plugin-sdk"

/** What the generated shims destructure. Keys match `RUNTIME_MODULES`. */
export interface StarbaseRuntime {
  readonly react: typeof React
  readonly jsxRuntime: typeof jsxRuntime
  /**
   * The plugin SDK's renderer half — this app's instance of it.
   *
   * Publishing the app's own copy is the whole point. The SDK owns the React
   * context the hooks read, and a context object is only meaningful to the
   * module that created it: if a plugin got a second copy of the SDK, its
   * `useHost()` would read a DIFFERENT context, find null, and throw "called
   * outside a plugin view" from inside a plugin view. One SDK instance, reached
   * through the shim, is what makes the hooks work at all.
   */
  readonly sdk: Record<string, unknown>
}

declare global {
  // eslint-disable-next-line no-var
  var __STARBASE_RUNTIME__: StarbaseRuntime | undefined
}

/**
 * Publish the runtime. Idempotent, and safe to call before anything mounts.
 *
 * Everything is available at module scope — React, the JSX runtime and the SDK
 * are all ordinary imports — so there is nothing to fill in later and no window
 * in which a plugin could observe a half-built surface. An earlier draft had a
 * `publishPluginSdk` that populated the `sdk` object after the fact, which was
 * both unnecessary and a bug waiting to happen: nothing ever called it, so every
 * plugin's `import { useHost } from "@starbase/plugin-sdk"` resolved to
 * `undefined`.
 */
export const publishPluginRuntime = (): void => {
  globalThis.__STARBASE_RUNTIME__ ??= {
    react: React,
    jsxRuntime,
    sdk: sdkModule as unknown as Record<string, unknown>
  }
}

// Published on import, so `import "./plugin-runtime.js"` in main.tsx is enough
// and no caller can forget the call.
publishPluginRuntime()
