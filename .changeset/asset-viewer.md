---
"@starbase/cli-adapters": minor
"@starbase/contracts": minor
"@starbase/core": minor
"@starbase/desktop": minor
"@starbase/ui": minor
---

Asset viewing — click a file path in agent output and read the thing the agent just made, without leaving the app.

- **The browser dock is now a Preview dock with tabs.** A pinned Browser tab plus one tab per open asset. Its toggle moves out of every pane's tab bar and into the **window title bar**: there was only ever one dock and one native browser view, and a copy of the control in each pane implied one per pane. `⌃⇧B` is unchanged.
- **Markdown, code, text, images, CSV/TSV and PDF** all render. Markdown reuses the transcript's own renderer, code reuses the diff engine's Shiki highlighter, and CSV parses to a virtualised table (a 50k-row export scrolls without mounting 50k rows).
- **PDFs use Chromium's own viewer** in a native `WebContentsView`, so the app ships no pdf.js. Their bytes never cross the RPC boundary — base64-ing 40 MB to the renderer so it could hand the path back was the whole cost of the feature for none of its benefit.
- **Three routes in**: a `Write`/`Edit` tool card's filename, an inline `` `docs/spec.md` `` span in prose, and a relative markdown link. All three are gated on the file actually existing in the session's worktree (the list the `@` menu already fetches), so `v1.2.3` and `npm.install` stay inert text rather than becoming dead links.
- **Reads are sandboxed to the worktree.** Agent output is untrusted input that happens to name files, so `AssetService` resolves the *real* path — through `..` and through symlinks — before comparing it against the worktree root, and refuses anything that escapes. The PDF viewer goes through the same check: the renderer sends a session id and a relative path, never a path main will trust. Per-kind size caps are checked against `stat` before any read, because checking after is the same as not checking.
- **The main window is now a one-way door.** `setWindowOpenHandler` denies every window-open request and hands http(s) to the user's real browser, and `will-navigate` refuses any cross-origin navigation. Electron gives a `window.open`ed child the *opener's* `webPreferences` — including the preload that exposes the RPC bridge — so a link in agent markdown was one click from handing a remote page a channel to Terminal/Workspace/Auth.
- **The worktree file list includes untracked files and refreshes mid-turn.** It gates both the `@` menu and asset clickability, and `git ls-files` alone is blind to a file the agent wrote *this turn* — which is the whole point of the feature.
- **The browser survives a tab switch.** Switching to an asset hides the native view rather than closing it, so its page, history and scroll position are still there when you switch back.
