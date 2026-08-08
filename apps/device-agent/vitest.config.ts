import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "device-agent",
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
})
