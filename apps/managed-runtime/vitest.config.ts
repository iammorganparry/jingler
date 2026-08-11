import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "managed-runtime",
    include: ["src/**/*.test.ts"],
    environment: "node"
  }
})
