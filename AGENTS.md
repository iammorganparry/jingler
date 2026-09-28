# AGENTS.md

Repo-wide rules for AI agents (and humans) working in Jingler. See `CLAUDE.md`
for the full architecture guide; this file is the short list of standing rules.

## Standing rules

- **Every new user-facing feature ships an end-to-end test.** Add a Playwright
  `_electron` spec under `apps/desktop/e2e/` that drives the feature through the
  real built app (the scripted agent stands in for the harness — see
  `apps/desktop/e2e/fixtures.ts`). The e2e suite is not in CI, so run it locally
  with `pnpm --filter @jingler/desktop e2e` before opening a PR. Unit/Storybook
  coverage is welcome too, but it does not replace the e2e.

- **Keep `pnpm lint`, `pnpm typecheck`, and `pnpm test` green** before opening a
  PR — CI runs all three.

- **Never hardcode a colour in a component** — use the `--sb-*` theme tokens
  (see the Theming section of `CLAUDE.md`).

- **Investigating memory or performance? Measure with the built-in monitor,
  don't guess.** Every dev launch (`pnpm dev`, never packaged builds) runs a
  perf monitor that samples process + renderer counters every ~20s and serves
  an agent API over loopback HTTP (discovery:
  `~/jingler/diagnostics/perf/endpoint.json`, bearer token inside — never
  print or commit it). Drive it with `pnpm perf <cmd>` — plain Node + curl
  under the hood, so it works from any agent harness or shell:

  - `pnpm perf status` — monitor health; `cdpAttached: false` means DevTools
    holds the renderer's only debugger slot.
  - `pnpm perf watch` / `pnpm perf history` — live counters, and an automated
    leak verdict (`blink-dom-leak`, `listener-leak`, `detached-documents`,
    `actor-eviction-failure`, `js-heap-leak`, `native-churn`, or `stable`).
  - `pnpm perf snapshot` · `cpu-profile [s]` · `alloc [s]` — heap snapshot /
    CPU profile / allocation-site sampling, written under
    `~/jingler/diagnostics/perf/`.
  - `pnpm perf renders start|stop|report` — per-component React render counts
    with unnecessary renders flagged.
  - `pnpm perf leak-check --warmup 60` — baseline/target/final heap-snapshot
    protocol; reproduce the leak during the warmup window and memlab names
    the leaking constructors and retainer paths.

  Full workflow and how to read the numbers (StrictMode double-mounts, GC
  sawtooth vs ratchet): `skills/perf-monitor/SKILL.md`.

- **Releasing the desktop app is a manual, three-workflow process — and it
  ships to every installed copy.** Never trigger any of it without the
  operator's explicit go-ahead: a release pushes a version commit and tag to
  `main`, publishes a GitHub Release marked *latest*, and every running app
  offers it through the auto-update widget.

  1. **Add a changeset** on `main`: `pnpm changeset` (pick patch/minor/major,
     write the user-facing summary), commit it. Every user-facing change
     should carry one with its PR — the summary line is what users read in
     the "Updated to Jingler X" card after they relaunch on the new version
     (`apps/desktop/src/renderer/use-release-notes.ts` shows the bundled
     `apps/desktop/CHANGELOG.md` entries since the last version they ran). The release refuses to run
     without at least one pending `.changeset/*.md`. All `@jingler/*` packages
     version in lockstep; the app version lives only in
     `apps/desktop/package.json` (`scripts/sync-app-version.mjs` mirrors it to
     the root `package.json`).
  2. **Certify that exact commit** — both must succeed on the same SHA the
     release will build:
     - *Pi provider certification* (`.github/workflows/pi-provider-evals.yml`,
       `workflow_dispatch`, input `max_cost_usd`, default 25). Runs the live
       provider matrix against real APIs, so it **spends money**; it uploads the
       `pi-provider-certification` artifact (the release manifest of selectable
       models).
     - *Native runtime certification*
       (`.github/workflows/native-runtime-certification.yml`, `workflow_dispatch`
       from the default branch). Runs claude / codex / opencode at their
       minimum and current versions on the **self-hosted**
       `native-runtime-certification` runner, so that runner must be online.
  3. **Run *Release*** (`.github/workflows/release.yml`, `workflow_dispatch`)
     with both run IDs: `native_certification_run_id` and
     `certification_run_id`. Its jobs:
     - **gate** — lint, typecheck, unit tests, deterministic pi eval, license
       check, verifies both certification runs succeeded *for `GITHUB_SHA`*,
       then runs the full Electron e2e suite under xvfb. Any red e2e blocks the
       release, so the local e2e suite has to be green first.
     - **version** — `pnpm version-packages`, commits `release: vX.Y.Z`, tags
       `vX.Y.Z`, pushes both to `main` (uses `RELEASE_TOKEN` when set).
     - **build** — macOS arm64 + x64, Linux x64, Windows x64 installers via
       `electron-builder --publish never`, then `pnpm artifacts:check` on each.
       macOS is signed and notarized only when all five `APPLE_*` secrets
       exist; otherwise it ships unsigned.
     - **publish** — merges the two per-arch `latest-mac.yml` feeds into one,
       creates the GitHub Release as a draft, uploads every asset, then flips
       it to published + latest.

  **How updates reach users:** `electron-builder.yml`'s `publish` block
  (GitHub provider, `iammorganparry/jingler`) is the update feed.
  `apps/desktop/src/main/updater.ts` checks on launch and every two hours,
  never auto-downloads, and publishes state to the sidebar update widget;
  the operator downloads from the widget, then confirms a restart.

  **Testing the update widget:** it only works in an app installed *from a
  published release* — electron-builder writes `app-update.yml` into those
  builds, and the updater reads it to find the feed. A local
  `pnpm --filter @jingler/desktop dist` build has no `app-update.yml` (its log
  shows `ENOENT … app-update.yml`) and never sees an update. To exercise the
  widget: install release N from GitHub Releases, publish N+1, relaunch N.
  On macOS, Squirrel only *installs* a signed update, so an unsigned release
  can show and download in the widget but fail at restart-to-install.

- **When renderer state starts adding up, model it as an XState machine.** A
  couple of independent `useState`s is fine. Reach for a machine in
  `apps/desktop/src/renderer/*-machine.ts` as soon as any of these is true:

  - three or more pieces of state that have to change **together** (one intent
    updating several setters — `openAsset` showing the dock *and* appending a
    tab *and* focusing it);
  - a value that is really a **mode** rather than data (`visible`, `loading`,
    `editing`) — that is a state, not a boolean;
  - state that must be **mirrored somewhere else** on every change (localStorage,
    RPC, the main process) — persistence belongs in a transition action, not
    duplicated next to each setter;
  - any async transition — model it as an invoked `fromPromise`/`fromCallback`
    actor rather than a data-fetching `useEffect`.

  The pattern is a `*-machine.ts` holding every rule plus a thin `use-*.ts` hook
  that calls `useMachine` and maps the snapshot to props (see
  `preview-dock-machine.ts` / `use-preview-dock.ts`, and `app-machine.ts`,
  `auth-machine.ts`, `conversation-machine.ts`). Machines get a `*.test.ts`
  driving them with `createActor` under the node environment — no rendering
  needed, which is most of the point.
