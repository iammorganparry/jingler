import { defineConfig } from "vitest/config"

/**
 * The SDK's runtime tests. Most of this package is types — checked by `tsc` via
 * `types.test-d.ts` — but `ui-exports.ts` is a hand-written list that must match
 * a real module, and only a runtime test can compare the two.
 */
export default defineConfig({
  test: {
    name: "plugin-sdk",
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
})
