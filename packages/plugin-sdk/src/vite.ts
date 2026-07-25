/**
 * The Vite config a plugin should build with.
 *
 * ## The one thing this exists to prevent
 *
 * Bundling React. A plugin runs inside Starbase's renderer and shares the app's
 * React instance, which reaches it through an importmap at runtime. A plugin
 * that bundles its own copy puts two Reacts in one tree, and every hook throws
 * "invalid hook call" — but only once a SECOND plugin is installed, because
 * alone the plugin's React is the only one mounting. So it is a bug an author
 * ships having genuinely tested their plugin end to end.
 *
 * The externals below are not an optimisation. Getting them wrong produces a
 * plugin that works for its author and breaks for everyone else.
 */

/** Specifiers Starbase provides at runtime. A plugin must never bundle these. */
export const STARBASE_EXTERNALS = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@starbase/plugin-sdk"
] as const

/**
 * A Vite `build` config for a plugin's UI entry.
 *
 * ES format with no code splitting: Starbase imports one module per plugin over
 * `starbase-plugin://`, and a split chunk would be fetched relative to that URL
 * — which works, but makes the manifest's `ui` path stop describing what
 * actually loads.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite"
 * import react from "@vitejs/plugin-react"
 * import { starbasePluginBuild } from "@starbase/plugin-sdk/vite"
 *
 * export default defineConfig({
 *   plugins: [react()],
 *   build: starbasePluginBuild({ entry: "src/ui.tsx" })
 * })
 * ```
 */
export const starbasePluginBuild = (options: {
  /** Your UI entry, e.g. `src/ui.tsx`. */
  entry: string
  /** Output directory. Must match the manifest's `ui` path. Defaults to `dist`. */
  outDir?: string
}) => ({
  outDir: options.outDir ?? "dist",
  lib: {
    entry: options.entry,
    formats: ["es"] as const,
    fileName: () => "ui.js"
  },
  rollupOptions: {
    external: [...STARBASE_EXTERNALS]
  },
  // One file, so the manifest's `ui` path is the whole truth about what loads.
  cssCodeSplit: false,
  // Plugins are read and debugged in place from `~/starbase/plugins`; a
  // stack trace pointing into minified soup helps nobody diagnose their own tab.
  minify: false as const,
  sourcemap: true
})
