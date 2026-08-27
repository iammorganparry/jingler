import { defineConfig, type BuildOptions } from "vite"
import { JINGLER_EXTERNALS, jinglerPluginBuild } from "@jingler/plugin-sdk/vite"

const build = jinglerPluginBuild({ main: "src/index.ts" }) as BuildOptions
export default defineConfig({
  build: {
    ...build,
    rollupOptions: { ...build.rollupOptions, external: [...JINGLER_EXTERNALS, /^node:/u] }
  }
})
