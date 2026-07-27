import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { jinglerPluginBuild } from "@jingler/plugin-sdk/vite"

/**
 * `jinglerPluginBuild` sets the externals that matter: react, react-dom, the
 * JSX runtimes and the SDK all come from Jingler at runtime. Bundling any of
 * them — React especially — puts two copies in one tree and makes every hook
 * throw, but only once a SECOND plugin is installed.
 */
export default defineConfig({
  plugins: [react()],
  build: jinglerPluginBuild({ ui: "src/ui.tsx", main: "src/main.ts" })
})
