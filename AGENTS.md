# AGENTS.md

Repo-wide rules for AI agents (and humans) working in Starbase. See `CLAUDE.md`
for the full architecture guide; this file is the short list of standing rules.

## Standing rules

- **Every new user-facing feature ships an end-to-end test.** Add a Playwright
  `_electron` spec under `apps/desktop/e2e/` that drives the feature through the
  real built app (the scripted agent stands in for the harness — see
  `apps/desktop/e2e/fixtures.ts`). The e2e suite is not in CI, so run it locally
  with `pnpm --filter @starbase/desktop e2e` before opening a PR. Unit/Storybook
  coverage is welcome too, but it does not replace the e2e.

- **Keep `pnpm lint`, `pnpm typecheck`, and `pnpm test` green** before opening a
  PR — CI runs all three.

- **Never hardcode a colour in a component** — use the `--sb-*` theme tokens
  (see the Theming section of `CLAUDE.md`).
