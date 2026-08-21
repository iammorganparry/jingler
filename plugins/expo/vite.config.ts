import { defineConfig, type BuildOptions } from "vite"
import react from "@vitejs/plugin-react"
import {
  JINGLER_EXTERNALS,
  jinglerPluginBuild
} from "@jingler/plugin-sdk/vite"

const build = jinglerPluginBuild({ ui: "src/ui.tsx", main: "src/main.ts" }) as BuildOptions

export default defineConfig({
  plugins: [react()],
  build: {
    ...build,
    rollupOptions: {
      ...build.rollupOptions,
      external: [...JINGLER_EXTERNALS, /^node:/u]
    }
  }
})
