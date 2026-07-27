/** Specifiers Jingler provides at runtime. A plugin must never bundle these. */
export declare const JINGLER_EXTERNALS: readonly [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@jingler/plugin-sdk",
  "@jingler/plugin-sdk/ui"
]

export interface JinglerPluginBuildOptions {
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
 * import { jinglerPluginBuild } from "@jingler/plugin-sdk/vite"
 *
 * export default defineConfig({
 *   plugins: [react()],
 *   build: jinglerPluginBuild({ entry: "src/ui.tsx" })
 * })
 * ```
 */
export declare const jinglerPluginBuild: (
  options: JinglerPluginBuildOptions
) => Record<string, unknown>
