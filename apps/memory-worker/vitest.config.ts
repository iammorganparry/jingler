import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL("./src/testing/cloudflare-workers.ts", import.meta.url).pathname
    }
  },
  test: {
    name: "memory-worker",
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
})
