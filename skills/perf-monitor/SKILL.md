---
description: Use when investigating memory leaks, high CPU, render churn, or any performance problem in the running Jingler dev app; covers the pnpm perf CLI, the dev perf monitor's HTTP API, leak-trend verdicts, heap snapshots, and memlab analysis.
---

# Performance monitor

The dev app (`pnpm dev`, un-packaged builds only) runs a passive performance
monitor in Electron main: every ~20s it samples process memory/CPU, renderer
heap counters over CDP, and app-level metrics, into
`~/jingler/diagnostics/perf/history.jsonl`, and serves a loopback HTTP API
discovered via `~/jingler/diagnostics/perf/endpoint.json` (port + bearer
token; respects `JINGLER_HOME`). Drive it with `pnpm perf <command>` — never
guess at leaks when you can measure.

## Workflow

1. `pnpm perf status` — is the monitor up, is CDP attached? `cdpAttached:
   false` usually means DevTools is open in the app window (the debugger slot
   is exclusive); renderer counters are absent until it closes.
2. `pnpm perf history` — recent samples plus an automated trend verdict.
   Verdicts encode this app's known leak signatures:
   - `blink-dom-leak` — Blink embedder heap grows, JS heap flat (detached
     nodes, listeners, style churn). This was the 19GB scroll-loop leak.
   - `detached-documents` — document count climbs in a one-window app.
   - `listener-leak` — jsEventListeners ratchets.
   - `actor-eviction-failure` — live conversation actors exceed the cap.
   - `js-heap-leak` — plain V8 retention.
   - `native-churn` — RSS grows, JS heap flat (buffers/compositor/IPC).
3. Reproduce the problem while `pnpm perf watch` runs; watch which counter
   moves with the repro.
4. `pnpm perf leak-check --warmup 60` — baseline snapshot, 60s for YOU to
   reproduce, target snapshot, settle, final snapshot; then memlab names the
   leaked constructors and retainer paths. (memlab runs via npx on demand.)
5. For CPU: `pnpm perf cpu-profile 15` during the churn; for allocation
   sites: `pnpm perf alloc 30`. Both print files loadable in Chrome DevTools.
6. For render churn: `pnpm perf renders start`, exercise the surface,
   `pnpm perf renders report` — per-component render counts with unnecessary
   renders highlighted (react-scan under the hood).

## Reading the numbers

- StrictMode is always on in dev: mount effects run twice; don't read doubled
  mount work as a leak.
- Sizes are bytes except `workingSetKb` (Electron reports KB); `watch` prints
  MB.
- GC sawtooth is normal — the trend detector requires ratcheting growth
  (monotonicity + r² gates) before it calls anything a leak. Trust `stable`.
- One heap snapshot pauses the renderer for seconds on a big heap; don't
  snapshot in a tight loop.

## Non-negotiables

- The monitor is dev-only (`!app.isPackaged`); never wire it into packaged
  builds or move the endpoint off loopback.
- `endpoint.json` holds a bearer token — never commit it, print it, or copy
  it into logs/PRs.
- Heavy ops are exclusive; a 500 "another operation is in flight" means wait,
  not retry-storm.
