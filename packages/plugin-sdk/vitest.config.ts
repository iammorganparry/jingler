import { defineConfig } from "vitest/config"

/**
 * The SDK's runtime tests. Most of this package is types — checked by `tsc` via
 * `types.test-d.ts` — but two hand-written lists have to match something a
 * compiler cannot see, and only a runtime test can compare them:
 *
 *   - `ui-exports.ts` against the UI kit module it names;
 *   - `STARBASE_EXTERNALS` across `vite.mjs`, `vite.d.ts` and `api-digest.md`.
 *
 * Both lists are hand-written for a reason the tests explain, and both trades
 * are only acceptable because the test makes the drift loud.
 */
export default defineConfig({
  test: {
    name: "plugin-sdk",
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
})
