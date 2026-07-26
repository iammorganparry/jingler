/** Specifiers Starbase provides at runtime. A plugin must never bundle these. */
export declare const STARBASE_EXTERNALS: readonly [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@starbase/plugin-sdk",
  "@starbase/plugin-sdk/ui"
]

export interface StarbasePluginBuildOptions {
  /** Your UI entry, e.g. `src/ui.tsx`. Emitted as `ui.js`. */
  entry?: string
  /** Clearer alias for `entry` when a plugin has both halves. */
  ui?: string
  /**
   * Your extension-host entry, e.g. `src/main.ts`. Emitted as `main.js`.
   *
   * Required if your manifest declares `main`. Omitting it produces a plugin
   * that loads fine and then fails at its first activation event, because the
   * file the manifest names was never written.
   */
  main?: string
  /** Output directory. Must match the manifest's paths. Defaults to `dist`. */
  outDir?: string
}

/**
 * A Vite `build` config for a plugin's UI entry, with the correct externals.
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
export declare const starbasePluginBuild: (
  options: StarbasePluginBuildOptions
) => Record<string, unknown>
