---
name: perf-monitor
description: Use when investigating memory leaks, high CPU, render churn, or any performance problem in the running Jingler dev app; covers the pnpm perf CLI, the dev perf monitor's HTTP API, leak-trend verdicts, heap snapshots, and memlab analysis. Works from any agent harness (Claude Code, Codex, Cursor, plain shell) — the CLI is plain Node and the API is loopback HTTP.
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
7. **Renderer huge but JS heap / nodes / listeners flat?** The CDP counters
   only see V8, Oilpan and DOM counts. `pnpm perf memory-dump --dumps 3`
   captures Chromium's memory-infra trace via contentTracing and prints, per
   process, every allocator (`partition_alloc/partitions/*`, `blink_gc`,
   `v8/isolate_*` — one per worker — `skia`, `web_cache`, `font_caches`,
   `malloc`, `discardable`) with a Δ across dumps, plus `blink_objects/*`
   instance counts (Resource, Document, Frame, LayoutObject, …). This is the
   only view that names PartitionAlloc growth. It does not use the debugger
   slot, so it works with DevTools open or a wedged CDP op.
   `pnpm perf memory-report <trace>` re-summarizes a saved trace. Reading it:
   - `blink_gc/main/heap` far above `allocated_objects` = Oilpan garbage
     between GCs, i.e. churn, not retention. `blink_objects/.../GeometryMapper*`,
     `PendingLayer`, `PaintChunk`, `LayoutResult` in the hundreds of thousands
     = something forces layout/paint every frame (a rAF that reads
     `getBoundingClientRect`, a JS-driven transform animation). Confirm with
     `cpu-profile`: `(program)` + `getBoundingClientRect` self time.
   - `PerformanceMeasure` in the hundreds of thousands = React 19.2's dev
     performance tracks; the renderer perf hook sweeps them every 5s.
   - `malloc/partitions brp_quarantined_bytes_per_minute` in the GB = native
     allocation churn (compositor/paint), same root cause as the above.
   - `v8 isolates:N` > 1 = workers; each has its own heap the CDP counters
     never see.
   - Use `--dumps 6 --interval 30` for a 3-minute Δ when hunting a ratchet.

## Reading the numbers

- StrictMode is always on in dev: mount effects run twice; don't read doubled
  mount work as a leak.
- Sizes are bytes except `workingSetKb` (Electron reports KB); `watch` prints
  MB.
- GC sawtooth is normal — the trend detector requires ratcheting growth
  (monotonicity + r² gates) before it calls anything a leak. Trust `stable`.
- One heap snapshot pauses the renderer for seconds on a big heap; don't
  snapshot in a tight loop.
- `workingSetKb` / `ps rss` UNDER-report a leaking renderer on macOS: a 13GB
  renderer showed 437MB RSS because 12.5GB was compressed/swapped. Check
  `footprint -p <pid>` (phys_footprint) and `vmmap --summary <pid>`. VM tag
  253 = PartitionAlloc (Blink strings/vectors/buffers/Skia), 255 = V8 +
  Oilpan, 252 = legacy Blink GC. Tens of thousands of 64K regions under tag
  253 = small-object slot spans, not one big buffer.
- `history`/`watch` show the app window's renderer by pid
  (`sample.rendererPid`); native preview views are separate Tab processes.
- Exclusive ops time out after 180s (`JINGLER_PERF_OP_TIMEOUT_MS`). A
  timeout means the renderer never answered the CDP command — typically
  because it is swapped out — and the lock is released; the command itself
  cannot be cancelled.

## No pnpm? Use the HTTP API directly

The CLI is a thin wrapper — any harness with a shell can talk to the monitor
with curl. Read `port` and `token` from the endpoint file, then:

```bash
EP=~/jingler/diagnostics/perf/endpoint.json   # respects $JINGLER_HOME
PORT=$(node -p "require('$EP').port"); TOKEN=$(node -p "require('$EP').token")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/status
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/metrics
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/history?limit=60"
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/heap-snapshot
```

Also available: `POST /gc`, `POST /cpu-profile/start|stop`,
`POST /alloc/start|stop`, `POST /renders/start|stop` + `GET /renders/report`,
`POST /leak-check` (JSON body `{"warmupMs": 60000}`). All responses are JSON.

## Non-negotiables

- The monitor is dev-only (`!app.isPackaged`); never wire it into packaged
  builds or move the endpoint off loopback.
- `endpoint.json` holds a bearer token — never commit it, print it, or copy
  it into logs/PRs.
- Heavy ops are exclusive; a 500 "another operation is in flight" means wait,
  not retry-storm.
