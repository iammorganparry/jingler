import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { starbasePluginBuild } from "@starbase/plugin-sdk/vite"

/**
 * `starbasePluginBuild` sets the externals that matter: react, react-dom, the
 * JSX runtimes and the SDK all come from Starbase at runtime. Bundling any of
 * them — React especially — puts two copies in one tree and makes every hook
 * throw, but only once a SECOND plugin is installed.
 */
export default defineConfig({
  plugins: [react()],
  build: starbasePluginBuild({ entry: "src/ui.tsx" })
})
