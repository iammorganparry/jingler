# Multi-chat visibility and performance

Approved approach: cap panes at three, keep main visible unless explicitly closed, and measure rich-transcript interactions before claiming 60fps.

- [x] Trace layout changes, queued handoff, and rendering; collect baseline measurements.
- [x] Fix shared pane rules and avoid unnecessary transcript renders.
- [x] Add regression tests and a repeatable rich-transcript multi-pane benchmark, including concurrent sessions.
- [x] Run tests and benchmark, tune measured bottlenecks, and report frame times and remaining limits.
- [x] Test the operator-approved bounded Activity retention experiment; compare FPS and memory, then reject it because the gain did not justify its cost and lifecycle problems.

## Review-corrected workload

The original single-session benchmark mislabeled an already-visible chat as an open and then closed main by index. Its single-session measurements below are historical only, not evidence of protected-main performance. The corrected workload opens an absent chat, moves/closes that same surface by identity, and asserts main remains visible after every action in both workloads.

Latest verified build after review fixes:

| Workload | Average FPS | p95 frame | Worst frame |
| --- | ---: | ---: | ---: |
| Single session, protected main | 134.8 | 7.8ms | 49.3ms |
| Three running sessions, protected main | 125.5 | 13.8ms | 75.8ms |

Concurrent action p95: switch 27.9ms, open 20.9ms, move 7.6ms, close 7.8ms. Heap after GC: 42.1MB; DOM nodes: 2,952. Cold opening/switching still exceeds the 16.7ms budget on some frames. The workload changed, so these are not a controlled before/after comparison with the earlier numbers.

Review verification: 183 focused unit tests passed; six built-Electron tests passed (corrected benchmarks, queue handoffs, and PR/reviewer session-switch coverage); UI and desktop typechecks passed; focused lint has no errors (warnings remain). New regressions failed against the old production code. The separate reported freeze remains unresolved; see `plans/pr-review-session-freeze.md`.

## Continued tuning

- [x] Inspect the current CPU profile for opening/session-switching costs.
- [x] Test small changes targeting forced layout and redundant row mounting; keep retention out.
- [x] Run the concurrent-session benchmark and regression checks; record results and remaining spikes.

### Continuation changes

- Pane geometry is measured only when the pane list/ratios change, not for focus-only renders (`layoutDependency`). Rich message rows also get layout containment.
- The virtualizer waits for both history and its viewport, then starts near the live edge with `initialOffset`. It no longer mounts the oldest rich rows merely to discard them on the first scroll. Tests cover both preloaded and delayed history.
- Fixed the follow-mode race exposed by this change: a resize at the live edge must not clear protection for an in-flight catch-up scroll. Initial positioning is protected before the first animation frame; wheel, touch, keyboard, and later manual scrolling still take priority.
- With that race fixed, a two-row overscan buffer passes the concurrent-send and scrolling checks. “Load earlier” is also tested to preserve the reader's position rather than jumping to the newest messages.

### Latest continuation measurements

| Three running sessions / 18 chat tabs | Average FPS | p95 frame | Worst frame | JS heap after GC | DOM nodes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fresh baseline before this continuation | 92.6 | 35.0ms | 132.1ms | 43.4MB | 4,525 |
| First passing run with smaller buffer | 118.8 | 14.6ms | 104.9ms | 42.2MB | 2,952 |
| Final repeat, including history-paging checks | 127.7 | 7.9ms | 62.6ms | 42.1MB | 2,952 |

The final single-session run averaged **139.3fps**, p95 **7.7ms**, worst **41.7ms**.

| Final concurrent-session action | Average FPS | p95 frame |
| --- | ---: | ---: |
| Switch session | 112.0 | 20.8ms |
| Open chat | 119.3 | 20.9ms |
| Move pane | 143.9 | 7.7ms |
| Close pane | 135.3 | 7.9ms |

Overall p95 now fits the 16.7ms/60fps budget in both final runs, without retention or increased heap. Cold opening/switching still has occasional spikes; not every frame meets that budget. These are 400ms interaction windows, not input-to-display latency measurements.

## Changes verified

- Both outer session splits and inner chat/view splits cap at three. Restoring an older layout preserves main when trimming overflow.
- Handoffs open beside main, replacing a non-main pane at capacity. Explicitly closing main stays respected across restoration; explicitly reopening its pane restores protection.
- Pane toolbar controls no longer publish a focus change before closing. That late active-chat publication could reopen the just-closed pane.
- Memoized pane content skips unchanged transcript renders during sibling moves. Width changes commit once, movement uses position transforms rather than animated `flexGrow`, and CSS layout/paint containment limits recalculation between panes. Outgoing transcripts no longer stay for an exit animation.
- Closed dropdowns no longer force layout and recreate resize observers on every render. The transcript virtualizer's row-key callback stays stable across unchanged row sets.

## Stress workload

`apps/desktop/e2e/multi-chat-perf.spec.ts` replays opening, reordering, closing, and session switching in the built Electron app. Each seeded chat has 240 messages containing Markdown, code blocks, tables, lists, and inline formatting. The multi-session case has three sessions with six chat tabs each: **4,320 seeded messages**.

One scripted turn is held busy in each session. The test verifies all three stay busy after switching, then sends another prompt from a previously idle chat in each session and checks its response. This tests concurrent active runs, not simultaneous live-provider token streams. Rapid scroll jumps check that transcript rows remain visible after pane changes.

Measurements cover 400ms interaction windows on this machine's high-refresh display. FPS is derived from animation-frame timestamps, not a guarantee of compositor presentation on other hardware. Repeated runs varied; p95 and worst-frame measurements matter more than average FPS alone.

## First-pass results

| Workload / revision | Average FPS | p95 frame | Worst frame |
| --- | ---: | ---: | ---: |
| Single-session baseline | 96.0 | 21.2ms | 153.8ms |
| Single-session final | 125.2 | 13.7ms | 91.1ms |
| Three running sessions, before dropdown/virtualizer fix | 77.0 | 49.4ms | 187.5ms |
| Three running sessions, final with CSS containment | 99.3 | 28.1ms | 111.3ms |

First-pass three-session results by action:

| Action | Average FPS | p95 frame |
| --- | ---: | ---: |
| Switch session | 59.8 | 62.6ms |
| Open chat | 77.7 | 42.2ms |
| Move pane | 136.2 | 7.7ms |
| Close pane | 123.2 | 13.9ms |

**First-pass limit:** movement and closing fit the 16.7ms budget at p95, but cold rich-chat opening and session switching still spiked above it. Profiling identified mounting and measuring rich transcript DOM as expensive; see the continuation measurements above for the subsequent improvements.

## Rejected retention experiment

Tested up to three recent session layouts and two hidden chat bodies per session using React Activity. This required handling portalled tab bars and idle actors evicted while hidden. A send-from-restored-chat check still failed with retention; the same check passed after reverting it. All retention code and its actor/portal handling were removed.

| Variant | JS heap after GC | DOM nodes | Average FPS | p95 frame |
| --- | ---: | ---: | ---: | ---: |
| Before retention | 43.5MB | 4,525 | 85.0 | 42.2ms |
| Retention experiment | 63.3MB | 23,892 | 88.6 | 41.2ms |
| Final without retention, with CSS containment | 43.3MB | 4,525 | 99.3 | 28.1ms |

Retention added about 20MB of JS heap and over five times the DOM nodes without a reliable overall frame-time win. JS heap is not total process/GPU memory. The smaller CSS containment change performed better without retaining additional pane trees.

The first smaller-overscan experiment was reverted after a concurrent-run check failed. Continued tracing later identified the follow-mode race that could leave newly arrived replies offscreen. After fixing that race, the two-row buffer passed; it is now used.

## Verification

- 411 tests passed across 28 focused Vitest files, including initial row selection, geometry measurement, and follow-mode race regressions.
- Five Electron e2e tests passed on the final build: rich multi-pane stress/scrolling and history paging, three concurrent sessions plus previously idle chat sends, queue editing, queued handoff, and repeated handoffs with explicit main closure.
- UI and desktop TypeScript checks passed. Focused Biome lint has no errors; existing warnings remain. `git diff --check` passed.
- Full repository test/lint/typecheck commands were not run. The environment uses Node 22.14.0 despite the repository declaring Node >=24.

Rerun after building:

```sh
pnpm --filter @jingler/desktop build
SKIP_E2E_BUILD=1 pnpm --filter @jingler/desktop e2e multi-chat-perf.spec.ts queue-actions.spec.ts
```

The multi-session CPU profile is written under `apps/desktop/test-results/multi-chat-perf-benchmark--d1999-ith-six-rich-chat-tabs-each/multi-session.cpuprofile`; subsequent Playwright runs can replace artifacts. Statistics are logged as `MULTI_CHAT_BENCH`, `MULTI_SESSION_BENCH`, and `MULTI_SESSION_MEMORY`.

## Official guides used

- React 19.2: [memo](https://react.dev/reference/react/memo), [useMemo](https://react.dev/reference/react/useMemo).
- Motion 12.42: [layout animations](https://motion.dev/docs/react-layout-animations?platform=react), [layoutDependency](https://motion.dev/docs/react-motion-component#layoutdependency).
- CSS: [layout and paint containment](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain).
- TanStack React Virtual 3.14.5 / Virtual Core 3.17.3: [Virtualizer](https://tanstack.com/virtual/latest/docs/api/virtualizer), including `enabled`, `initialOffset`, stable `getItemKey`, and overscan cost.
- Benchmark counters: Chrome DevTools Protocol [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) and [Memory](https://chromedevtools.github.io/devtools-protocol/tot/Memory/).
- Rejected experiment: React [Activity](https://react.dev/reference/react/Activity) and XState [actor lifecycle](https://stately.ai/docs/actors).
