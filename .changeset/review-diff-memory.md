---
"@starbase/cli-adapters": patch
"@starbase/desktop": patch
"@starbase/ui": patch
---

Fix a multi-gigabyte renderer on the Code Review tab, and a crash on quit.

- **The Code Review tab no longer mounts the whole changeset at once.** `ReviewDiff` is non-virtualized — correct when the tab showed one file at a time, and quietly false once the continuous scroll stacked every file. Each line is about ten React fibers (row, two gutters, sign, one span per syntax token), so a 12.6k-line diff mounted half a million of them and held ~320MB; a real branch across two panes is where the multi-gigabyte renderer came from. Each file's lines now mount only near the viewport, with the file you're working in pinned so a half-written inline comment survives scrolling. Measured on that same diff: **321.9MB → 51.5MB**.
- **Resizing the review pane no longer re-renders every line.** `DiffLine` was unmemoized with per-row handler closures, so every frame of a resize drag — and every step of a line selection — re-rendered all of them, allocating ~35MB per pass. It is now memoized behind stable handlers: six resize passes cost 0.7MB total.
- **A diff changing under a mounted pane no longer retains the old one.** An agent editing files while the tab was open stepped the renderer up ~118MB and never gave it back.
- **The app no longer aborts on quit with a terminal open.** PTYs were reclaimed through a promise, so `before-quit` returned and Electron tore the Node environment down with shells still running — node-pty's reader thread then fired a ThreadSafeFunction into an environment already in `CleanupHandles()`, which napi refuses and node-addon-api turns into an uncaught C++ exception. The crash reported as `SIGABRT` out of `pty.node`, looking like anything but "we quit with a shell open". They are now killed synchronously, listeners disposed first.
