# Multi-chat visibility and performance

Approved approach: cap panes at three, keep main visible unless explicitly closed, and measure rich-transcript interactions before claiming 60fps.

- [x] Trace layout changes, queued handoff, and rendering; collect baseline measurements.
- [x] Fix shared pane rules and avoid unnecessary transcript renders.
- [x] Add regression tests and a repeatable rich-transcript multi-pane benchmark, including concurrent sessions.
- [x] Run tests and benchmark, tune measured bottlenecks, and report frame times and remaining limits.
- [x] Test the operator-approved bounded Activity retention experiment; compare FPS and memory, then reject it because the gain did not justify its cost and lifecycle problems.

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

## Results

| Workload / revision | Average FPS | p95 frame | Worst frame |
| --- | ---: | ---: | ---: |
| Single-session baseline | 96.0 | 21.2ms | 153.8ms |
| Single-session final | 125.2 | 13.7ms | 91.1ms |
| Three running sessions, before dropdown/virtualizer fix | 77.0 | 49.4ms | 187.5ms |
| Three running sessions, final with CSS containment | 99.3 | 28.1ms | 111.3ms |

Final three-session results by action:

| Action | Average FPS | p95 frame |
| --- | ---: | ---: |
| Switch session | 59.8 | 62.6ms |
| Open chat | 77.7 | 42.2ms |
| Move pane | 136.2 | 7.7ms |
| Close pane | 123.2 | 13.9ms |

**Remaining limit:** movement and closing fit the 16.7ms budget at p95 in this run, but cold rich-chat opening and session switching still spike above it. A blanket steady-60fps claim would be false. Profiling still shows mounting and measuring rich transcript DOM as expensive.

## Rejected retention experiment

Tested up to three recent session layouts and two hidden chat bodies per session using React Activity. This required handling portalled tab bars and idle actors evicted while hidden. A send-from-restored-chat check still failed with retention; the same check passed after reverting it. All retention code and its actor/portal handling were removed.

| Variant | JS heap after GC | DOM nodes | Average FPS | p95 frame |
| --- | ---: | ---: | ---: | ---: |
| Before retention | 43.5MB | 4,525 | 85.0 | 42.2ms |
| Retention experiment | 63.3MB | 23,892 | 88.6 | 41.2ms |
| Final without retention, with CSS containment | 43.3MB | 4,525 | 99.3 | 28.1ms |

Retention added about 20MB of JS heap and over five times the DOM nodes without a reliable overall frame-time win. JS heap is not total process/GPU memory. The smaller CSS containment change performed better without retaining additional pane trees.

A smaller overscan experiment was also reverted after the concurrent-run check failed; the existing six-row buffer remains.

## Verification

- 398 tests passed across 26 focused Vitest files; final CSS containment also passed the Electron checks below.
- Five Electron e2e tests passed on the final build: rich multi-pane stress/scrolling, three concurrent sessions plus previously idle chat sends, queue editing, queued handoff, and repeated handoffs with explicit main closure.
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
- Motion 12.42: [layout animations](https://motion.dev/docs/react-layout-animations?platform=react).
- CSS: [layout and paint containment](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain).
- TanStack React Virtual 3.14: [Virtualizer](https://tanstack.com/virtual/latest/docs/api/virtualizer), including stable `getItemKey` and overscan cost.
- Benchmark counters: Chrome DevTools Protocol [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) and [Memory](https://chromedevtools.github.io/devtools-protocol/tot/Memory/).
- Rejected experiment: React [Activity](https://react.dev/reference/react/Activity) and XState [actor lifecycle](https://stately.ai/docs/actors).
