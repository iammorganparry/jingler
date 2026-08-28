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
