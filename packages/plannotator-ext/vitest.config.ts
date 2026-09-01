import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "plannotator-ext",
    environment: "node",
    include: ["*.test.ts"]
  }
})
