# Enforce repository complexity limits

Baseline: 312 Biome cognitive-complexity findings across 186 files and 117 Oxlint cyclomatic-complexity findings across 99 files (204 unique files).

- [x] Confirm installed rule support and capture the strict baseline.
- [x] Refactor `packages/cli-adapters` below Biome 15 and Oxlint 20.
- [x] Refactor `packages/ui` below Biome 15 and Oxlint 20.
- [x] Refactor `apps/desktop` below Biome 15 and Oxlint 20.
- [x] Refactor server, relay, device-agent, and auth-state apps below both limits.
- [x] Refactor managed-runtime below both limits.
- [x] Refactor remaining core, themes, plugin, and plannotator files below both limits.
- [x] Enable both rules as errors at their strict defaults.
- [x] Run package tests, full tests, typechecks, builds, lint gates, and independent review.
