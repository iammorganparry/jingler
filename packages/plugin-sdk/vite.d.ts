/** Specifiers Starbase provides at runtime. A plugin must never bundle these. */
export declare const STARBASE_EXTERNALS: readonly [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@starbase/plugin-sdk"
]

export interface StarbasePluginBuildOptions {
  /** Your UI entry, e.g. `src/ui.tsx`. */
  entry: string
  /** Output directory. Must match the manifest's `ui` path. Defaults to `dist`. */
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
