import { defineConfig } from "vitest/config"

/**
 * Root Vitest config using the "projects" feature so each workspace package
 * owns its own test setup. `pnpm test` (vitest run) discovers every package
 * config matched below and runs all suites in one pass. Coverage is a
 * gap-finding lens (report only), never a gate.
 */
export default defineConfig({
  test: {
    // The Cloudflare relay intentionally runs on Vitest 4, required by the
    // current Workers pool. Keep it out of this Vitest 3 project graph; the
    // root `test` script invokes that package in a second, isolated process.
    projects: [
      "packages/*/vitest.config.ts",
      "apps/desktop/vitest.config.ts",
      "apps/memory-worker/vitest.config.ts",
      "apps/server/vitest.config.ts"
    ],
    // Cap each project's fork pool. Without this, Vitest sizes every project's
    // pool to the CPU count — on an 11-core box the suites collectively fork
    // 30-40 workers, each loading Effect/Electron deps and ballooning to
    // 100-460 MB, which pins memory and drives the machine into swap. This root
    // cap is inherited by every project's pool (verified: cap N holds each
    // project to N workers), so total peak ≈ N × overlapping projects. Keep it
    // small on memory-constrained machines; raise via VITEST_MAX_WORKERS (CI
    // can bump it on a bigger box).
    pool: "forks",
    minWorkers: 1,
    maxWorkers: process.env.VITEST_MAX_WORKERS
      ? Number(process.env.VITEST_MAX_WORKERS)
      : 2,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Scoped to the backend logic this pass covers. Renderer/UI component
      // coverage belongs to the deferred jsdom + Testing Library pass.
      include: [
        "packages/core/src/**",
        "packages/contracts/src/**",
        "packages/cli-adapters/src/**",
        "packages/themes/src/**",
        "apps/desktop/src/main/**"
      ],
      // Vendored theme presets are generated colour tables, not logic — every
      // line is data and covering them would only inflate the number.
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "**/test-support.ts",
        "packages/themes/src/presets/**"
      ]
    }
  }
})
