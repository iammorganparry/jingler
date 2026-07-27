/**
 * The singletons a plugin's ES module imports.
 *
 * ## The problem this solves
 *
 * A plugin ships `import { useState } from "react"`. The importmap in
 * `index.html` points that bare specifier at
 * `jingler-plugin://runtime/react.js`, and the main process serves a generated
 * shim for it (`main/plugin-protocol.ts`). That shim does not contain React — it
 * reads `globalThis.__JINGLER_RUNTIME__` and re-exports off it.
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
import * as reactDom from "react-dom"
import * as sdkModule from "@jingler/plugin-sdk"
import * as sdkUiModule from "@jingler/plugin-sdk/ui"

/** What the generated shims destructure. Keys match `RUNTIME_MODULES`. */
export interface JinglerRuntime {
  readonly react: typeof React
  readonly jsxRuntime: typeof jsxRuntime
  /**
   * `react-dom`, as its own singleton.
   *
   * It used to be aliased to the React shim, which exports none of its
   * bindings — so a plugin doing `import { createPortal } from "react-dom"`
   * died at module instantiation with "does not provide an export named
   * createPortal". `JINGLER_EXTERNALS` tells every plugin to externalise
   * react-dom, so that was the supported path leading straight into a wall.
   */
  readonly reactDom: typeof reactDom
  /**
   * The plugin SDK's renderer half — this app's instance of it.
   *
   * Publishing the app's own copy is the whole point. The SDK owns the React
   * context the hooks read, and a context object is only meaningful to the
   * module that created it: if a plugin got a second copy of the SDK, its
   * `useHost()` would read a DIFFERENT context, find null, and throw "called
   * outside a plugin view" from inside a plugin view. One SDK instance, reached
   * through the shim, is what makes the hooks work at all.
   *
   * Typed as the module itself rather than `Record<string, unknown>`. Nothing
   * reads these through TypeScript — the generated shims destructure them at
   * runtime in plain JS — so the loose type bought nothing and cost the one
   * place that documents what a plugin actually receives.
   */
  readonly sdk: typeof sdkModule
  /** The themed UI kit, at `@jingler/plugin-sdk/ui`. */
  readonly sdkUi: typeof sdkUiModule
}

declare global {
  // eslint-disable-next-line no-var
  var __JINGLER_RUNTIME__: JinglerRuntime | undefined
}

/**
 * Publish the runtime. Idempotent, and safe to call before anything mounts.
 *
 * Everything is available at module scope — React, the JSX runtime and the SDK
 * are all ordinary imports — so there is nothing to fill in later and no window
 * in which a plugin could observe a half-built surface. An earlier draft had a
 * `publishPluginSdk` that populated the `sdk` object after the fact, which was
 * both unnecessary and a bug waiting to happen: nothing ever called it, so every
 * plugin's `import { useHost } from "@jingler/plugin-sdk"` resolved to
 * `undefined`.
 */
/**
 * `react/jsx-runtime` plus a `jsxDEV` that exists in every build.
 *
 * A plugin built by Vite in DEVELOPMENT mode emits `jsxDEV(...)` calls and imports
 * `react/jsx-dev-runtime`. The shim for that specifier took its export NAMES from
 * the union of both namespaces — so `jsxDEV` was exported — while taking its
 * VALUES from `jsxRuntime`, which does not have it. The name resolved to
 * `undefined`, and the plugin died on its first element with
 * `jsxDEV is not a function`.
 *
 * That broke the official `github-issues` plugin's tab in development, and every
 * dev-built third-party plugin with it. The comment beside `RUNTIME_MODULES`
 * already claimed this fallback existed; it did not.
 *
 * `jsxDEV` takes the extra `(source, self)` arguments React's dev runtime uses for
 * warnings and drops them here. Losing a dev-only warning is the right trade
 * against a plugin that cannot render, and it is what makes a dev-built plugin
 * loadable against a PACKAGED app, where React ships no dev runtime at all.
 */
const jsxRuntimeWithDev = {
  ...jsxRuntime,
  jsxDEV:
    (jsxRuntime as { jsxDEV?: unknown }).jsxDEV ??
    ((type: unknown, props: unknown, key: unknown) =>
      // `jsxs` handles a children array; `jsx` does not. Dev builds route both
      // through `jsxDEV`, so picking by shape is what keeps a fragment with two
      // children from rendering as one.
      Array.isArray((props as { children?: unknown } | null)?.children)
        ? (jsxRuntime as unknown as { jsxs: Function }).jsxs(type, props, key)
        : (jsxRuntime as unknown as { jsx: Function }).jsx(type, props, key))
}

export const publishPluginRuntime = (): void => {
  globalThis.__JINGLER_RUNTIME__ ??= {
    react: React,
    jsxRuntime: jsxRuntimeWithDev as typeof jsxRuntime,
    reactDom,
    sdk: sdkModule,
    sdkUi: sdkUiModule
  }
}

// Published on import, so `import "./plugin-runtime.js"` in main.tsx is enough
// and no caller can forget the call.
publishPluginRuntime()
