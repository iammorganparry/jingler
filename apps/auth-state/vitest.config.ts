import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "auth-state",
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
})
