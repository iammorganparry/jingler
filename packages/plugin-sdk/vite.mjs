/**
 * The Vite config a plugin should build with.
 *
 * ## Why this file is plain JavaScript, alone in a TypeScript package
 *
 * Every other module here ships as raw `.ts`, because every other consumer is a
 * bundler or the Starbase renderer, both of which transpile. This one is
 * imported by `vite.config.ts` — which Vite hands to **Node**, and Node cannot
 * load `.ts`. Shipping it as TypeScript produced
 * `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"` on the very first
 * `vite build` a plugin author would ever run.
 *
 * Types live beside it in `vite.d.ts`, so authors still get completion.
 *
 * ## What this exists to prevent
 *
 * Bundling React. A plugin runs inside Starbase's renderer and shares the app's
 * React, which reaches it through an importmap at runtime. A plugin that bundles
 * its own copy puts two Reacts in one tree and every hook throws "invalid hook
 * call" — but only once a SECOND plugin is installed, because alone the plugin's
 * React is the only one mounting. So it is a bug an author ships having
 * genuinely tested their plugin end to end.
 *
 * The same applies to the SDK, and more sharply: the SDK owns the React context
 * the plugin hooks read, and a context object is only meaningful to the module
 * instance that created it. A plugin with its own copy would call `useHost()`
 * inside a plugin view and be told it was outside one.
 */

/** Specifiers Starbase provides at runtime. A plugin must never bundle these. */
export const STARBASE_EXTERNALS = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@starbase/plugin-sdk"
]

/**
 * A Vite `build` config for a plugin's UI entry.
 *
 * ES format with no code splitting: Starbase imports one module per plugin over
 * `starbase-plugin://`, and a split chunk would make the manifest's `ui` path
 * stop describing what actually loads.
 */
export const starbasePluginBuild = (options) => ({
  outDir: options.outDir ?? "dist",
  lib: {
    entry: options.entry,
    formats: ["es"],
    fileName: () => "ui.js"
  },
  rollupOptions: { external: [...STARBASE_EXTERNALS] },
  cssCodeSplit: false,
  // Plugins are read and debugged in place from `~/starbase/plugins`; a stack
  // trace pointing into minified soup helps nobody diagnose their own tab.
  minify: false,
  sourcemap: true
})
