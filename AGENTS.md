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

- **Releasing the desktop app is one manual workflow — and it ships to every
  installed copy.** Never trigger it without the operator's explicit
  go-ahead: a release pushes a version commit and tag to `main`, publishes a
  GitHub Release marked *latest*, and every running app offers it through the
  auto-update widget.

  1. **Add a changeset** on `main`: `pnpm changeset` (pick patch/minor/major,
     write the user-facing summary), commit it. Every user-facing change
     should carry one with its PR — the summary line is what users read in
     the "Updated to Jingler X" card after they relaunch on the new version
     (`apps/desktop/src/renderer/use-release-notes.ts` shows the bundled
     `apps/desktop/CHANGELOG.md` entries since the last version they ran).
     The release refuses to run without at least one pending
     `.changeset/*.md`. All `@jingler/*` packages version in lockstep; the app
     version lives only in `apps/desktop/package.json`
     (`scripts/sync-app-version.mjs` mirrors it to the root `package.json`).
     Check the planned bump first with `pnpm exec changeset status` — it must
     stay below 1.0.0 (`pnpm version:check`).
  2. **Run the local e2e suite** (`pnpm --filter @jingler/desktop e2e`). The
     release does not run it, so a red e2e is only caught here.
  3. **Run *Release*** (`.github/workflows/release.yml`, `workflow_dispatch`,
     `channel: stable`): `gh workflow run release.yml --ref main -f channel=stable`.
     Its jobs:
     - **preflight** — resolves the channel; a scheduled nightly skips itself
       when `main` has not moved since the last nightly.
     - **gate** — lint, typecheck, unit tests, license check, on the same
       self-hosted runner and environment as CI (a hosted ubuntu runner runs
       out of memory in the monorepo typecheck).
     - **version** — stable: `pnpm version-packages`, commits `release: vX.Y.Z`,
       tags, pushes to `main`. Nightly: `<next patch>-nightly.<date>.<run>`,
       stamped into the build only — never committed.
     - **build** — macOS arm64 + x64, Linux x64 + arm64 (AppImage), Windows x64
       via `electron-builder --publish never` (arm64 Linux is
       `optional`: `continue-on-error`, published only when they built). Each
       leg runs `pnpm artifacts:check` and `scripts/distribution/smoke-packaged-app.mjs`
       (boots the packaged app for 20s). Signing: macOS when all five `APPLE_*`
       secrets exist, Windows via Azure Trusted Signing when the `AZURE_*`
       secrets exist; otherwise unsigned — except a **stable macOS build, which
       fails without the `APPLE_*` secrets**. An unsigned Mac app is trusted by
       its cdhash alone, so every update re-prompts for the login keychain
       password ("Jingler Safe Storage") and Squirrel cannot install it; the
       *Verify macOS signature* step checks the shipped bundle's designated
       requirement is Developer ID (team + bundle id), not a cdhash.
     - **publish** — merges each channel's per-arch manifests
       (`scripts/distribution/merge-update-manifests.mjs`), writes `SHA256SUMS`,
       publishes the GitHub Release (stable: *latest*; nightly: prerelease).
     - **aur** — repackages the x86_64 AppImage as `jingler-bin` /
       `jingler-nightly-bin` (`packaging/aur/release.sh`) when
       `AUR_SSH_PRIVATE_KEY` is set; otherwise skipped.

     Nightlies need no changeset: `gh workflow run release.yml --ref main -f channel=nightly`,
     or wait for the daily schedule.

     Installers are named `Jingler-<version>-<arch>.<ext>` (T3 Code's
     convention). Stable builds read `latest*.yml`; builds whose version
     contains `-nightly.` read `nightly*.yml` and accept prereleases
     (`updateChannelFor` in `apps/desktop/src/main/updater.ts`).

  There is no provider or model certification step: Jingler drives the
  operator's own harnesses and credentials. The *Pi provider certification*
  and *Native runtime certification* workflows still exist for ad-hoc
  checking, but releases neither run nor require them, and builds embed the
  committed (empty) `packages/core/src/runtime/release-certification-manifest.json`.

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
