import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { jinglerPluginBuild } from "@jingler/plugin-sdk/vite"

export default defineConfig({
  plugins: [react()],
  build: jinglerPluginBuild({ ui: "src/ui.tsx", main: "src/main.ts" })
})
