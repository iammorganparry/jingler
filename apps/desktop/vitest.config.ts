import { defineConfig } from "vitest/config"

/**
 * Unit tests for the desktop app: the main-process RPC handler folding, plus the
 * renderer's conversation state machine (pure XState logic with `rpc-client`
 * mocked — no `window`, so it runs under node).
 *
 * `node` stays the default because almost everything here is logic rather than
 * markup, and jsdom costs real time to stand up per file. The handful of tests
 * that DO mount components opt in per file with a
 * `// @vitest-environment jsdom` docblock — cheaper and more honest than
 * splitting the suite in two, and it keeps the choice visible in the file that
 * needs it.
 */
export default defineConfig({
  test: {
    name: "desktop",
    environment: "node",
    include: [
      "src/main/**/*.test.ts",
      "src/renderer/**/*.test.ts",
      "src/renderer/**/*.test.tsx"
    ]
  }
})
