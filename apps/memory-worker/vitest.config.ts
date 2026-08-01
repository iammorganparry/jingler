import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "memory-worker",
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
})
