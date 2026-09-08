# Session-switch latency

- [x] Start from merged main and trace sidebar selection, pane mounting, actor reuse, and closed file-picker work.
- [x] Measure cold and repeat click-to-usable-frame latency in the built Electron app with rich concurrent sessions and PR/reviewer views.
- [x] Fix measured blocking work without retaining hidden session trees; add behavior regressions.
- [x] Rerun latency, sending, scrolling, and focused checks; report repeat-switch target (<100ms) and remaining cold costs.

Approved isolated investigation. Previous benchmark FPS and Playwright round-trip timings are not click-to-usable-frame measurements. The earlier Activity retention experiment remains rejected.

## Changes and evidence

- Disable initial opacity animation on session-group replacement using Motion 12.42.2's `AnimatePresence initial={false}`. Adding/reordering panes still animates. Guide: https://motion.dev/docs/react-animate-presence#initial
- Do not build file-picker items while closed. The rich-session CPU profile put `FileQuickOpen` path splitting at the top of named JavaScript self-time (186ms across the profiled workload).
- Remove synchronous actor eviction from `getConversationActor`. The existing 100ms coalesced publisher already enforces the six-actor cap. Evicting during render stopped a newly created sibling before the selected session's visibility was published. The strengthened benchmark reproduced a blank transcript that stayed empty beyond five seconds on old code, and passes after this fix. No cache-cap increase or hidden session trees.

## Measurement definition

The shared test helper times an in-page click through two animation-frame callbacks after the target content exists and the session pane is fully opaque. Rich-chat readiness requires a rendered row intersecting **every** transcript viewport. This is a scripted click-to-visible-content proxy, not hardware input/compositor presentation timing. The prior Playwright round-trip timings included locator waits and were not comparable.

Three scripted running sessions have six chats each, 4,320 rich messages, and a repository with 4,000 extra files. Cached switches first exercise one chat per session (within the actor cap). Later, three panes per session exceed the six-actor cap and intentionally exercise reloading evicted chats. The initial already-open session is not counted as a cold switch.

| Final repeat | Median | Range |
| --- | ---: | ---: |
| Cached rich session | 46.4ms | 43.1–80.5ms |
| PR/reviewer session switching | 49.2ms | 22.8–172.2ms |
| Three-pane sessions with actor eviction/reload | 165.2ms | 148.1–176.5ms |

The two genuine first visits measured 96.0ms and 110.4ms. Cached-switch and PR/reviewer **median** regression budgets are below 100ms; outliers and actor-reload cases do not all meet that target. The reported one-to-two-second delay was not reproduced in isolation, and the previously reported live freeze is not claimed fixed.

## Verification

- 4,426 root Vitest tests passed across 459 files. The three new production regressions fail against old code (switch opacity, closed-picker work, sibling actor eviction).
- Six built-Electron tests passed, including per-pane visible rows during switching, both latency budgets, queued handoffs, subsequent sends, history paging, and scrolling.
- UI and desktop typechecks passed. Focused Biome lint has no errors (24 warnings remain). `git diff --check` passed.
- Temporary load-timing diagnostics were removed and the final Electron build was rebuilt without them.
- Local Node was 22.14.0; repository requirement is >=24. No full Cloudflare-suite rerun in this follow-up.

Logs: `/tmp/noble-borg-switch-verified-e2e.log`, `/tmp/noble-borg-switch-all-unit.log`. JSON timings and CPU profiles are attached under `apps/desktop/test-results/`; later Playwright runs can replace them.
