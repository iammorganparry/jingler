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
  "@starbase/plugin-sdk",
  "@starbase/plugin-sdk/ui"
]

/**
 * A Vite `build` config for a plugin.
 *
 * Builds BOTH halves when a plugin has both. Getting this wrong is silent and
 * late: the manifest declares `main: "dist/main.js"`, the UI-only build never
 * writes it, and the plugin loads perfectly until the first activation event
 * fires and the host cannot find the file. Passing `main` here is what stops
 * that being something an author discovers from a user.
 *
 * Output names are fixed (`ui.js`, `main.js`) and match what the manifests in
 * `plugins/` declare — one fewer thing to keep in agreement by hand.
 *
 * ES format with no code splitting: Starbase imports one module per plugin over
 * `starbase-plugin://`, and a split chunk would make the manifest's `ui` path
 * stop describing what actually loads.
 */
export const starbasePluginBuild = (options) => {
  const input = {}
  // `entry` is the UI half; `ui` is accepted as a clearer alias for a plugin
  // that has both, since "entry" stops meaning anything once there are two.
  const ui = options.ui ?? options.entry
  if (ui) input.ui = ui
  if (options.main) input.main = options.main

  return {
    outDir: options.outDir ?? "dist",
    rollupOptions: {
      input,
      external: [...STARBASE_EXTERNALS],
      output: {
        format: "es",
        entryFileNames: "[name].js",
        // No shared chunk. Two entries that both touch a helper would otherwise
        // emit a third file neither manifest mentions, and the host half loads
        // in Node while the UI half loads over a custom scheme — a chunk they
        // both import has to resolve in both, which it would not.
        manualChunks: undefined,
        inlineDynamicImports: false
      },
      preserveEntrySignatures: "exports-only"
    },
    cssCodeSplit: false,
    // Plugins are read and debugged in place from `~/starbase/plugins`; a stack
    // trace pointing into minified soup helps nobody diagnose their own tab.
    minify: false,
    sourcemap: true
  }
}
