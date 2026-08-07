# @jingler/desktop

## 2.0.3

### Patch Changes

- d0761df: Run release packaging in a cross-platform shell so Windows installers publish successfully.

## 2.0.2

### Patch Changes

- 9dddee8: Embed Browser in its owning session with a responsive, resizable chat split.

## 2.0.1

### Patch Changes

- 7a8a9dc: Prevent electron-builder from traversing the bundled plugin SDK workspace symlink when packaging desktop installers.

## 2.0.0

### Minor Changes

- 3deb8c2: Agentic adversarial code review — a reviewer agent that argues _against_ a pull request, manually or automatically, with findings routed back to the working agent.

  - **Adversarial review of a PR** — a reviewer agent runs in the session's worktree, is fed the PR diff, and hunts for defects (logic, security, performance, regressions, missing coverage) plus how the code will age (simplicity, duplication across the repo, repo convention, over-abstraction). Findings are structured — severity, file, line, rationale, suggested fix — and ranked worst-first in the Pull Request rail and anchored to their file in Code Review.
  - **Reviewer model is configurable** (Settings · GitHub), defaulting to **Fable** (`claude-fable-5`): its 1M context swallows large diffs whole, and the point of an adversarial review is to critique a diff with a _stronger_ model than the one that wrote it — so this stays deliberately decoupled from the per-session Providers default.
  - **Auto-run on new commits** (opt-in, off by default) — reviews a PR when it opens and each time its head advances, de-duped on the PR head SHA so an unchanged head costs one `gh pr view` and spawns nothing.
  - **Send any finding to the working agent** to address, through the session's conversation (so its work and any approval gates surface in the Conversation tab).
  - **Reviews are read-only by construction** — the reviewer can read and search the worktree but cannot edit files or run commands, enforced by the harness itself (`SessionSpec.readOnly`: Claude refuses the write tools; Codex runs a read-only sandbox) rather than by prompt.

- fa256c7: Make the orchestrator agentic instead of scripted. It now speaks in one natural
  voice on every harness (no more "step X of Y"), plans only to draft its FIRST
  plan, and after approval works in auto mode with its native tools — editing,
  running git/gh, opening PRs, invoking skills — so quick work gets done in place
  and never re-opens the approval gate.

  For larger follow-up work it amends the plan in place: re-issuing the complete
  plan as one `html plan` block is applied as a reconciled amendment (stable
  stage/acceptance ids and durable worker evidence preserved, changed and new
  stages requeued) and the affected workers are dispatched automatically — no
  second approval.

  A "Jingler mode" toggle in the composer hides the model and mode chips while it
  is on; turning it off drops the session back to driving the source harness
  directly (chips return, no orchestrator persona), persisted as
  `orchestratorEnabled` in config.

- f948464: Asset viewing — click a file path in agent output and read the thing the agent just made, without leaving the app.

  - **The browser dock is now a Preview dock with tabs.** A pinned Browser tab plus one tab per open asset. Its toggle moves out of every pane's tab bar and into the **window title bar**: there was only ever one dock and one native browser view, and a copy of the control in each pane implied one per pane. `⌃⇧B` is unchanged.
  - **Markdown, code, text, images, CSV/TSV and PDF** all render. Markdown reuses the transcript's own renderer, code reuses the diff engine's Shiki highlighter, and CSV parses to a virtualised table (a 50k-row export scrolls without mounting 50k rows).
  - **PDFs use Chromium's own viewer** in a native `WebContentsView`, so the app ships no pdf.js. Their bytes never cross the RPC boundary — base64-ing 40 MB to the renderer so it could hand the path back was the whole cost of the feature for none of its benefit.
  - **Three routes in**: a `Write`/`Edit` tool card's filename, an inline `` `docs/spec.md` `` span in prose, and a relative markdown link. All three are gated on the file actually existing in the session's worktree (the list the `@` menu already fetches), so `v1.2.3` and `npm.install` stay inert text rather than becoming dead links.
  - **Reads are sandboxed to the worktree.** Agent output is untrusted input that happens to name files, so `AssetService` resolves the _real_ path — through `..` and through symlinks — before comparing it against the worktree root, and refuses anything that escapes. The PDF viewer goes through the same check: the renderer sends a session id and a relative path, never a path main will trust. Per-kind size caps are checked against `stat` before any read, because checking after is the same as not checking.
  - **The main window is now a one-way door.** `setWindowOpenHandler` denies every window-open request and hands http(s) to the user's real browser, and `will-navigate` refuses any cross-origin navigation. Electron gives a `window.open`ed child the _opener's_ `webPreferences` — including the preload that exposes the RPC bridge — so a link in agent markdown was one click from handing a remote page a channel to Terminal/Workspace/Auth.
  - **The worktree file list includes untracked files and refreshes mid-turn.** It gates both the `@` menu and asset clickability, and `git ls-files` alone is blind to a file the agent wrote _this turn_ — which is the whole point of the feature.
  - **The browser survives a tab switch.** Switching to an asset hides the native view rather than closing it, so its page, history and scroll position are still there when you switch back.

- 1eed467: Sessions now compact their own context in the background, so a long conversation stops losing accuracy without anyone having to intervene.

  - **Compaction fires on a quality budget, not a percentage of the window.** Attention degrades well before a model's hard ceiling — the usable band is roughly 256k–400k tokens — so a percentage rule would let a 1M-window model run to 650k before acting, which is precisely the rot worth avoiding. The trigger is an absolute budget (300k by default, adjustable within the band). The window survives only as a backstop: `min(budget, window × 0.85)`, so a 200k model compacts at 170k because it _must_, and a 1M model at 300k because it _should_.
  - **It never calls `/compact`, and is harness-agnostic as a result.** `TranscriptStore` already holds a normalized `Message[]` for every session regardless of which CLI produced it, so Jingler summarises _its own_ transcript and reseeds a fresh harness conversation with the result — through the two seams every adapter already honours (`SessionSpec.resumeId` and the prompt). Claude, Codex and opencode get identical behaviour with no cooperation from any vendor.
  - **Your transcript is never truncated.** Only the model's working set shrinks; scroll back and the whole conversation is still there. That is the property `/compact` cannot offer, and a collapsible "Context compacted" divider in the transcript shows exactly what was carried forward — because a context meter that simply drops between turns with no explanation is why compaction reads as data loss.
  - **Summaries cost nothing extra.** The digest runs through the CLI you have already signed in to, on its cheapest tier — the first consumer of `ProviderConfig.backgroundModel`, documented since it landed as "small/fast model for summaries & side tasks". No API client is constructed anywhere in that path, so switching this on cannot produce a bill you did not expect.
  - **Everything degrades toward doing nothing.** A failed digest, an unknown window, or a harness that reports no usage all leave a session behaving exactly as it does today, with the harness's own limit still the backstop. Not compacting costs a slower session; compacting wrongly costs a session that has forgotten what it was doing, so the asymmetry is deliberate. Two consecutive failures stop a session retrying rather than forking a doomed fiber every turn.
  - **Codex reports its context size.** It emitted `Done { tokens: 0 }` by design, on the grounds that the exec SDK exposes turn totals rather than thread context. That was half right: a Codex turn resends the whole thread, so `input + output` _is_ the context the next turn inherits. The two subset fields stay out of the sum — adding cached input and reasoning output double-counts both, and on a heavily-cached session the cache is most of the input.
  - **The meter measures against the compaction point, not the ceiling.** A 1M-window model reads full at ~300k, because that is where quality starts to go; a bar sitting at 30% there would say the opposite of what matters. It renders nothing for a harness that reports no usage rather than an empty bar that would read as "plenty of room left", and nothing goes red — crossing the trigger is the system working. It also names the state a compaction is in, including the one nobody can cause themselves: a summary being built right now.
  - **Settings → Context collects every token lever**, with the budget shown alongside what it _means_ per harness ("170k of 200k"), which model summarises, and live per-session readings — so the budget can be set against reality rather than in the abstract. `Session.tokens` finally holds the real number too; it had been written as `0` at creation and never touched again, so a session reopened at 290k read as empty and would run to the ceiling before anything noticed.

- 59305ae: Render GitHub PR review threads faithfully, and stop auto-mode swallowing the agent's questions.

  - **Raw HTML no longer leaks as literal text.** `Markdown` passed `remarkPlugins`/`rehypePlugins` to Streamdown, which _replaces_ its defaults rather than extending them — dropping `rehype-raw` (Streamdown then actively rewrites HTML to visible source, so Greptile's `<details>` blocks and `<picture>` badges rendered as markup) _and_ `remark-gfm` (silently breaking tables, strikethrough, task lists and autolinks in every PR **and issue** body). Math now goes through Streamdown's `plugins.math` config, which appends after the defaults and preserves their array identity — which `allowedTags` requires to work at all.
  - **Inline review threads.** The Pull Request tab now groups inline comments into GitHub-style review threads — a per-review header, a collapsible per-file box, the anchored diff hunk with old/new gutters, nested replies with Bot/Owner chips and reactions, and `Outdated`/`Resolved` badges. Sourced from GraphQL `reviewThreads` (`PullRequest.reviewThreads`); REST `/pulls/{n}/comments` cannot report resolution state at all. Resolved threads start collapsed, matching GitHub's "Show resolved".
  - **Resolve / unresolve and reply** round-trip to GitHub via the new `Github.resolveThread` and `Github.replyToThread` RPCs.
  - **Auto mode no longer discards the agent's questions.** `auto` mapped to the SDK's `bypassPermissions`, which skips the `canUseTool` callback entirely (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) — but that callback is also where `AskUserQuestion` and `ExitPlanMode` are intercepted, so questions were auto-approved, run headlessly and silently skipped, and the question card never docked. It now maps to `default`; gating is unchanged because the runner's own `verdict()` already allows everything in `auto`.

- eed78b1: A global command palette — ⌘K from anywhere to jump between sessions and run the app's actions, instead of reaching for the sidebar.

  - **⌘K/⌘P on macOS, Ctrl+K/Ctrl+P elsewhere — not either-or.** The app's usual posture is `meta || ctrl` on every platform, and that holds for the split map because its chords are all ⌃⇧-something. K and P are different: on macOS, Ctrl+K and Ctrl+P are Cocoa caret bindings Chromium implements in every text field (kill-line, previous-line), so accepting bare Ctrl would take both away from the composer and pop a modal instead, on the one platform where ⌘K already works. The chord also bails on an already-handled event, so anything nearer the target keeps a key it has claimed.
  - **The sidebar filter moves to ⌘F.** ⌘K is the chord people arrive already knowing, and until now it put the caret in a list filter — while `empty-conversation.tsx` had been rendering a `⌘K Command palette` hint for a palette that did not exist. The filter keeps a chord rather than losing one.
  - **Fuzzy, not substring.** `ssb` finds `jingler/session-sidebar`. The sidebar's own filter is `String.includes`, which answers "no results" to an abbreviation — the single most common thing anyone types into a palette. Characters matched at a word start or adjacent to the previous one score higher, so the ordering reflects what you typed rather than what merely matched.
  - **Built on a new `Command` atom (shadcn/cmdk)**, not a hand-rolled listbox. A command list is more keyboard than it looks: arrow nav that skips headings, wrap-around, type-ahead, and `aria-activedescendant` pointed at a row the input never gives focus to. Every shadcn colour class was translated to an `--sb-*` token on the way in — a literal `bg-popover` is invisible to the theme system and reads as white-on-white on a light theme. The atom and the palette both ship Storybook stories.
  - **Sessions, actions, the active session's tabs, and plugin commands.** New Session, Show/Hide Terminal, Show/Hide Browser, Archive/Restore, Open Settings, Sign out. Tab rows are built from the same `when` predicates the pane uses, so a session with no plan is never offered "Go to Plan". An unavailable capability produces **no row** rather than a disabled one — in a palette there is nowhere to show why a thing is greyed out, and a row that selects and does nothing is indistinguishable from a bug.
  - **`contributes.commands` finally has a surface.** `CommandContribution` in `@jingler/core` is documented verbatim as "an entry in the command palette" and `Plugins.invoke` has existed alongside it; there was simply no palette. Commands are listed only for plugins that are enabled, loaded, **and declare a `main` entry** — the handler lives in the host half, and Jingler starts no host process without one. A manifest promising commands with no `main` is now a load failure rather than a palette row that dispatches into nothing, which is the same refusal `contributes.tabs` with no `ui` already gets.
  - **Two capabilities crossed the shell boundary to get here.** The terminal dock's visibility lives in the renderer (`onToggleTerminal` / `terminalActive`), and a pane's active tab is pane-local state, now reachable through a `selectTabRequest` nonce handed to the **focused** pane only — broadcasting it would switch all four tabs in a four-way split. The request is **one-shot**: a pane is keyed by session id and remounts on every switch, so an uncleared request would replay onto the next session you opened, and one "Go to Changes" would look like a setting rather than an action.
  - **Archived sessions are last, not hidden.** Copying the sidebar's default filter would make the palette answer "no results" for a session that plainly exists.

- d9875be: Restore Bash calls to the original expandable tool output, make the transcript token readout report the current context size (including cached context and compaction), and show live Codex plan limits in the Usage & limits modal.
- 272f34a: Introduce authentication and gate the desktop app behind a sign-in wall.

  - New `@jingler/server` auth backend: BetterAuth over Postgres/Drizzle on Hono,
    runnable locally (`@hono/node-server` + Docker Postgres) and deployable to
    Vercel. Supports GitHub OAuth, Google OAuth, and email magic links.
  - Desktop `jingler://` deep-link sign-in with the bearer token stored in the OS
    keychain (Electron `safeStorage`), a new `AuthService` + `Auth.*` RPCs, and a
    dedicated `authMachine` that gates the whole app until signed in.
  - New sign-in UI: `LoginScreen` plus reusable `OAuthButton`, `AuthDivider`,
    `Starfield`, `MagicLinkForm`, and `AuthCard` components.
  - Server DB access is Effect-TS: a `Database` service + per-aggregate
    Repositories (e.g. `UserRepository`), run via a `ManagedRuntime`. All
    hand-written queries go through a repository (BetterAuth's adapter is the one
    documented exception); `GET /api/me` is the first consumer.

- 142c0fe: Rebrand: the app now ships Jingler's own identity end to end.

  - **App icons.** `build-resources/icon.{png,ico,icns}`, generated from the mark by
    `scripts/generate-brand-icons.py`. Every installer previously shipped Electron's
    default icon.
  - **Two brand themes.** `jingler-dark` (now `DEFAULT_THEME_ID`) and `jingler-light`,
    hand-authored VS Code themes on warm-neutral greys off `#212121` with `#EF3F57`
    as the brand accent. Operators with a saved `theme.activeId` keep it.
  - **A `--sb-brand` token,** separate from `--sb-red`, so the primary action and the
    destructive action are not the same swatch. `--primary`, `--ring` and links now
    resolve through it.
  - **A retuned accent ramp.** All seven accents were rebuilt inside the brand's
    saturation/lightness envelope (S 52-88% / L 60-75% on dark) with warm-leaning
    hues, so they read as one family instead of a stock VS Code spectrum. Every one
    clears 4.5:1 against its theme's editor background, and a test pins the envelope.
  - **`Kbd`'s `onFill` chip is a white scrim,** not `bg-blue` — it was invisible while
    primary was also blue and became a blue tile on a red button the moment primary
    moved to the brand.
  - **Self-hosted fonts.** Hanken Grotesk and JetBrains Mono were named in
    `globals.css` but shipped nowhere, so the app silently rendered in `system-ui`
    everywhere. Both now bundle as variable woff2 via `@fontsource-variable/*`.
  - **A new loading screen** — the brand mark run through a Paper Design `Heatmap`
    shader, with per-ground prop sets and static fallbacks for `prefers-reduced-motion`
    and renderers without WebGL. Replaces the rocket-emoji splash.
  - **The real mark** replaces the `✦` placeholder on the auth card, first-run screen,
    empty state, component library and provider list.
  - **The splash runs the shader full-bleed** on its own `colorBack`, so there is no
    visible tile edge — matching the page colour alone was not enough, because the
    shader's grain lifts its rectangle above a flat fill.
  - **The sign-in wall lost its starfield** for a flat canvas and the card's brand
    halo. A starfield said nothing about Jingler.
  - **The brand mark is in the title bar**, centred with the window title.
  - `docs/brand.md` writes the rules down; a `Brand` Storybook page renders them live.

- f842e84: Plan-mode cycling, per-mode composer theming, per-step plan flows, and sidebar archive/delete quick actions.

  - **Shift+Tab reaches Plan mode** on Claude sessions (the cycle now includes `plan`; other harnesses keep the 3-mode cycle).
  - **Composer "nightlight"** — the composer border/background/glow and the mode chip are colour-coded per HITL mode (ask=blue, accept-edits=green, auto=orange, plan=purple).
  - **Per-step plan flows** — decision/state-machine flows now live on each `PlanStep` (parsed from ` ```flow step NN ` `` blocks) and render inside that step's spec, instead of one flow for the whole plan; Plan Review opens on the first step that has a flow.
  - **Sidebar archive/delete quick actions** — each session row exposes Archive/Restore/Delete via hover buttons and a right-click context menu, with a confirmation dialog before deleting.

- 37c10d5: Nested sub-agent tabs — a sub-agent that spawns its own sub-agents now gets them as tabs, at any depth.

  - **Nested spawns open their own tab.** Previously only a `Task` from the MAIN agent opened a tab; a `Task` spawned _by_ a sub-agent stayed a plain tool card, and the nested agent's output was **dropped entirely** — `applySubagentEvent` couldn't place an event whose `agentId` matched no open tab, and sub-agent events never reach the transcript store, so that output was unrecoverable rather than merely hidden.
  - **The sub-agent list stays flat, and models the tree with a `parentId` pointer** rather than nested `children` arrays. The SDK stamps `parent_tool_use_id` with the _immediate_ parent, so every agent already has a globally-unique id that events route to by a direct id match at any depth; the renderer derives the tree on read (`agentChildren` / `agentPath`).
  - **The tab bar drills down instead of growing sideways.** A flat strip can't express depth, so it shows one level at a time: a breadcrumb of the drill path, then a cell per agent at that level, with a `>` affordance on any agent that spawned its own. The strip stays a fixed height at any depth.
  - **An ancestor ending settles its still-working descendants.** Each nested agent normally gets its own `SubagentEnded` from its own `tool_result`, but an ancestor that errors or aborts can leave children with no result of their own — without this they'd pulse "working" forever.
  - **Fixed: a finished sub-agent's tab pulsed its "working" dots forever.** A sub-agent's rolling message is born `streaming: true`, and only a `Done` event clears that — but `Done` is a MAIN-turn event (no `agentId`), so it never reached a sub-agent and _nothing_ could settle its message. `SubagentEnded` now settles the message as well as the status, as does the end-of-run sweep for an interrupted turn (which flipped `status` only, while the spinner is driven by the message flag).
  - **Fixed: backgrounded sub-agents settled ~150ms after spawn.** A `Task` run in the background returns its `tool_result` almost immediately — an "Async agent launched successfully" ACK, not a completion — so the tab read "done" while the agent actually ran for minutes. The tab now settles on the SDK's `task_notification` bookend (`system` / `subtype: 'task_notification'`), which carries the spawning `tool_use_id` and a `completed | failed | stopped` status, and fires at the true completion. Verified against the SDK that it fires for synchronous Tasks too (just before their `tool_result`), so it is the correct single settle signal either way; the end-of-run sweep still backstops an aborted run. These `system` messages were previously dropped wholesale by an `if (msg.subtype !== "init") return []`.

  Sub-agents remain live-only (not disk-persisted), and token usage is still attributed to the main agent only — unchanged from before.

- ce51af4: Notion-like plan workspace — the plan PRD becomes an editable, live document.

  - **Flow diagrams render.** A fenced ` ```mermaid ` block in a plan (or any agent
    markdown) now renders as a themed, sandboxed SVG diagram instead of a grey code
    block — lazy-loaded, `securityLevel: strict`, with an inline error card for a
    broken diagram so one bad fence never blanks the doc.
  - **Inline (WYSIWYG) editing.** A new **Edit** mode renders section bodies as
    in-place rich-text editors (Tiptap) that read from and serialize back to
    markdown; edits splice into the authoritative MDX via a surgical section
    rewriter and save through the existing conflict-safe machinery. The
    Source/Rendered/Split modes are unchanged.
  - **Comment on a highlighted span.** Plan annotations can now carry a W3C-style
    TextQuote anchor (quote + context), threaded end-to-end (parse, serialize,
    persist, RPC) with a resolver that re-anchors robustly and flags orphaned
    comments. Open comments are still batched to the agent in one revision by
    `Agent.revisePlan`.
  - **Live document.** The renderer subscribes to a streaming `Plan.watch` RPC
    instead of polling — the agent's writes and external edits to
    `current-plan.mdx` reach an open editor in about a second.

- af42847: opencode as a harness — run OSS and gateway models (OpenRouter, opencode Zen, and anything else the user has configured) alongside Claude, Codex and Cursor.

  - **A real adapter, not a scripted stub.** opencode is driven through its SDK client against a server Jingler spawns itself — matching the SDK-driven idiom of the Claude and Codex adapters. Deliberately _not_ the SDK's `createOpencodeServer`: it spawns a bare `opencode` off `PATH` with no executable override (contrast Claude's `pathToClaudeCodeExecutable` / Codex's `codexPathOverride`), which breaks Jingler's discovery model — and an Electron GUI app on macOS doesn't inherit the shell `PATH`, so a user whose opencode lives in `~/.opencode/bin` would silently get "not found". It also overwrites `OPENCODE_CONFIG_CONTENT`, clobbering our injection. So we spawn `<binPath> serve`, parse the URL it prints, and use the SDK purely as a typed client.
  - **Real per-tool HITL** — better than Codex's sandbox-only control, close to Claude's. opencode raises permission requests on an event bus and takes replies on a separate endpoint; the adapter bridges that asynchronous loop onto Jingler's promise-shaped `ctx.canUseTool`, so the session's own mode and allowlist decide. `readOnly` is still enforced at the harness (denied tools) rather than trusted to the callback, because a tool that never raises a permission would sail past it — the same reasoning as the Codex sandbox. Under `accept-edits` an in-worktree edit applies without asking, as that mode means — but reaching _outside_ the worktree still asks, and so does any permission kind opencode adds in future: trusting edits to your worktree is not trusting edits to your disk.
  - **BYOK, respected rather than replaced.** Jingler never owns an opencode credential: keys are written through opencode's _own_ auth API, exactly as `opencode auth login` would. So a key added in Jingler works in a bare `opencode` shell, a key already added there works here, and `SecretStore` keeps holding exactly one thing — the Jingler bearer token. Settings · Providers lists every provider opencode knows, showing where each live one's credential came from (environment / signed in / `opencode.json` / built-in) so it's visible whose key is whose — and offering to add one only where none resolves. The ~165 providers with no key stay behind a search rather than flooding the page. **OpenRouter needs no special handling at all** — it's native to opencode via models.dev, so an `OPENROUTER_API_KEY` alone resolves ~342 models with zero config injection (contrast OpenRouter-for-Claude-Code, which needs an `ANTHROPIC_BASE_URL` override).
  - **The model catalogue is the user's, so we ask them for it.** opencode resolves providers from their own credentials — with none configured only Zen's free tier resolves — so the list comes live from the running binary rather than a table that would go stale. Ids stay provider-qualified and labels carry the provider, because the menu groups by _harness_: "Claude Opus 4.5" is ambiguous when the same model is reachable through both Zen and OpenRouter.

    A `ProviderConfig.visibleModels` curation narrows the composer's menu, since a single OpenRouter key is not a usable flat menu — but **nothing writes it yet**: the picker that does lands separately, and for now only a hand-edited `config.json` sets it. It deliberately never narrows Settings' default-model picker, so a curation can always be undone from the screen you'd use to change it.

  - **Gated to opencode ≥ 1.18.** The 1.0.x line lacks `--auto`/`--fork`/`--variant` and predates opencode's SQLite session store; supporting both regimes isn't worth it. A too-old binary reports unavailable _with a note_ naming the version found and the fix, so it's distinguishable from a missing one. Jingler never bundles its own opencode: a bundled copy fights the user's install over their shared session database.

  - **Subagents get their own tabs.** opencode's `task` tool runs its subagent in a child session with its own id, so its work — and, critically, its permission requests — arrive under an id that isn't the run's. Each child session opens a watch-only tab, its output is attributed to it, and nesting comes free from the session's `parentID`, the same shape Claude's adapter gets from `tool_use` ids. Spawning one isn't gated (Claude doesn't gate `Task` either); the subagent's own edits and commands are, under the same rules as the main agent's.

  Also fixes switching an existing session's harness from the model chip. A resume id only means something to the harness that issued it, and the store already drops the persisted one on a switch — but the adapters' live in-memory map outlived it and won, so the new harness was handed the old one's thread id and every turn failed until the app restarted. It's dropped on a switch now, which fixes Claude↔Codex as much as the new harness.

  Plan mode stays Claude-only — opencode's `plan` agent restricts tools but emits no plan for review, so there is nothing for the approve/revise contract to bind to.

- 5ce4b9a: Run multiple chats in one session at the same time.

  A session's chats share one git worktree, and the harness used to refuse a second
  run while any run in the session was live — starting chat B while chat A worked
  came back as "Another chat or plan in this session is running." That guard existed
  to stop two agents mutating the shared worktree at once, but it also blocked the
  common, safe case: a second chat reviewing, planning, or working a different
  corner of the tree while the first runs.

  The reservation now gates concurrency PER OWNER instead of per session: distinct
  owners — a chat per chatId, a plan execution per `plan:<id>`, a planning round —
  run concurrently against the shared worktree, so a second chat can review, plan,
  or work another corner while the first runs. Like Conductor's shared-workspace
  mode, those concurrent chats aren't locked against each other; conflicting file
  edits are the operator's call. But a single owner stays single-flight, because
  two runs sharing one owner would corrupt rather than parallelise:

  - **Same chat** — a racing double-send or a second window would start two runs on
    one chatId, orphaning the first's fiber (unstoppable, since `stop` reads only
    the latest) and minting colliding positional message ids from one transcript
    snapshot. The second run is refused.
  - **Same plan** — a double-click on approve would run two executors over the same
    steps in the shared worktree, applying every edit and command twice. Refused.
  - **Concurrent planning** — `PlanStore` keeps one plan artifact per worktree, so
    two planning rounds in one session would clobber it (the second's `promote`
    replaces the first's, and approving the first then fails). Planning is
    single-flight per session until the artifact can hold more than one plan.

  Three things that were keyed per-session and would have collided under concurrency
  are now keyed per-chat:

  - **The run lock** that orders a stop against the next turn's setup was
    session-wide, so stopping chat A blocked chat B's setup. It follows the `fibers`
    map it protects — which is already per-chat — so two chats set up and stop
    independently.
  - **Background-task stop handles** were a single per-session slot: chat B starting
    a run orphaned chat A's still-running background tasks and stole its stop handle.
    Handles are now per-chat, and a stop routes to the chat that produced the task.
  - **The background-task level signal** (which tasks are still live) is per-run, so
    one chat's signal used to settle another chat's tasks as finished. The sweep is
    now scoped to the chat the signal came from.

  The renderer already kept one conversation actor per chat and streamed
  off-screen chats, and the chat tab bar already showed a per-chat running dot — so
  both chats keep working and stay visible while you switch between them.

- eb62eb6: Add persistent per-session chats with isolated transcripts and runner state, a shared session-level Plan Review artifact, provider-native reasoning controls, chat management shortcuts, and restart-safe desktop lifecycle behavior.
- f3bb880: Keep important sessions in a persistent sidebar tray, with their live agent
  status and session actions restored across app restarts.

  New sessions can now opt out of an isolated worktree and run directly on the
  selected branch in the repository checkout. Jingler guards the shared checkout
  against competing direct sessions and branch drift, and deleting a direct
  session leaves the repository and its Git registration untouched.

  Long conversations now open from an indexed recent window and page older turns
  without re-reading the full transcript. Plan cards stay canonical across those
  pages, chat-level Jingler mode persists independently, and the refreshed chat
  chrome keeps title editing and view navigation predictable. The wider plan
  workspace and static branded composer treatment keep long-running operational
  sessions readable without continuous background animation.

- abec0fa: Plan progress beside the transcript, durable composer drafts, and a session state that says what the agent is actually doing.

  - **The plan's steps now sit beside the Conversation as a progress rail**, so execution is legible without leaving the transcript. Clicking a step deep-links into Plan Review focused on it. There's no router in this app — tabs are local state and the only programmatic navigation was a hard-coded `setTab("plan")` — so the rail widens that one seam (`onOpenPlanReview(stepId?)` + a one-shot `planStepId` the host retires once Plan Review reports its own pick) rather than introducing routing. Progress is inferred upstream by matching the agent's edits against each step's proposed `files`, so a step is either proposed or done; the rail renders only what that signal can support.
  - **Flow diagrams open full-screen.** A step's decision flow was capped at a 300px panel, which large graphs outgrow. Either variant now expands into a near-fullscreen modal, rendered unembedded so it regains its header and minimap.
  - **Fixed: an embedded flow's node → step navigation was a dead click.** `PlanStepDetail` rendered `PlanFlow` without `onSelect`, though the canvas has always supported the jump.
  - **Composer drafts survive a session switch.** Switching sessions unmounts the composer (the pane is keyed by session id) and the draft went with it. That unmount is load-bearing — keeping panes mounted-but-hidden corrupts the virtualized transcript's measurement cache — so the draft is hoisted into a per-session store instead, persisted to `localStorage` and cleared on send or delete. Attachments ride along, degrading to text-only rather than losing the draft if they blow the storage quota. `Composer` gained optional controlled `value`/`attachments` and stays uncontrolled without them.
  - **Fixed: a plan that skipped the ```plan fence was silently DISCARDED.** `parsePlan`'s fallback built a step whose intent read "the agent's full plan is shown below" — but nothing rendered `plan.raw`, and `PlanReview` only auto-opened a step carrying a flow graph, which the fallback step has none of. The plan's entire contents were invisible. The first fence-less plan is now bounced back for one reformat through the same `deny.message` channel a revision uses (so the operator never sees the broken version), and if the agent still won't comply its markdown renders rather than vanishing. Exactly one retry — a model that won't comply degrades to the fallback instead of looping.
  - **Sessions report what the agent is doing, not a permanent "Thinking".** Every moment of a run collapsed to one word because the registry discarded the `ToolCall` name/target already in the transcript. A live `SessionActivity` is now derived from the in-flight tool: `Running pnpm test -- auth`, `Reading session.ts`, `Delegating …`, `Monitoring PR #482` (a `gh pr`/`--watch` command runs for minutes, so reporting it as "Running" reads as a hang). "Thinking" is now the fallback — the model reasoning with no tool open — rather than the catch-all. It's live-only and never crosses the RPC boundary; `activityStatus` rolls it up to the coarse `SessionStatus` the sidebar's group-by and status dot already needed, which finally gives the `running` literal real sessions.
  - **`Session.status` is no longer dead data.** It was written once at creation and never updated, so a session you hadn't opened always read "idle" — even one blocked on your approval. A new `Sessions.setStatus` RPC records it when a turn settles. Only settled statuses are ever persisted: a run lives in the main process and dies with the app, so recording "thinking" would strand the session in it forever after a restart.

- 09f4690: Switch provider from the model chip, real Codex models, and a reviewer you can actually watch.

  - **Switch harness from the composer's model chip** — models are grouped under the harness that offers them, so picking one picks its provider too. Only installed harnesses are listed. Switching mid-session starts the new harness on a fresh thread (a Codex thread id means nothing to Claude), degrades Claude-only Plan mode to `ask`, and refetches the `/` menu, since skills are per-harness.
  - **Codex's model list now comes from the Codex CLI itself** (`codex app-server` → `model/list`), so it is the real, current catalogue — `gpt-5.6-sol` and friends, with the CLI's own default first. The old path asked the OpenAI **API** for it, which needed an `OPENAI_API_KEY` that Codex users on ChatGPT subscription auth do not have, and returned a different vocabulary anyway — so it always fell through to a hardcoded list of models that no longer exist. Claude is unchanged: its aliases (`opus`/`sonnet`/`haiku`) are valid and stable.
  - **Models are discovered at startup**, while the window paints and you sign in, so the chip is populated by the time you open a session. Deliberately fire-and-forget: a cold cache is a slower chip, never a slower app.
  - **Watch the adversarial reviewer work** — it now appears in the agent tab bar as a "Reviewer" tab, streaming its activity like any sub-agent, and its tab survives a restart (its findings already did). Previously a multi-minute agent ran behind a bare spinner with its output discarded.
  - **The review button reports where the reviewer is** — starting → reading → thinking → writing findings, with a live timer. No percentage: nothing in a review announces a total, and the findings arrive as one block at the very end, so a bar would be invented. It reports auto-reviews too, not just ones you started.

- 334ebfc: Queued messages now behave like Claude Code's: the head of the queue is handed to
  the LIVE turn at the next tool boundary instead of waiting for the whole turn to
  settle, so a correction typed 10 seconds in reaches the agent while it is still
  relevant. Claude gains native steering for this (the adapter holds the SDK's
  streaming input open for the life of the turn); harnesses with no channel into a
  running turn are untouched rather than interrupted.

  Each queued row also gains icon actions: send now, hand off, edit, remove.
  Hand-off forks the message into a fresh chat on the default model from
  Settings › Providers — for the follow-up that turns out to be its own job.

- 777d6d2: Background work, plan review and the pull request page each stop claiming something they can't back up.

  - **A backgrounded sub-agent no longer appears twice.** A `Task` opens its tab at `tool_use` time — the only moment we hear about it, and a synchronous sub-agent would otherwise render nothing for its whole run. Whether the harness _backgrounded_ it is revealed later, by `background_tasks_changed`, so the same work showed up in both the agent tab bar and the dock. The tab is now retracted (with its descendants) when the level signal lands, joined on `BackgroundTaskStarted.toolUseId` — the spawning tool_use id, i.e. exactly the tab's own. Prevention isn't possible here; retraction on the later signal is. `task_notification` also stops emitting a `SubagentEnded` for a task it already promoted to the dock — inert today only because `applySubagentEvent` guards on membership, but the one place the pipeline still spoke about background work as if it were a tab.
  - **Settled background tasks leave the dock.** `BackgroundTaskStore` kept one actor per task forever — `clear()` was the only removal path and had no callers, so a long session accumulated dead rows indefinitely. Terminal tasks now age out after a 10s grace, computed lazily on read rather than on a per-task timer: the renderer already polls every 2s, so eviction is observed just as promptly with no fiber to leak or cancel. A `failed` task is held until dismissed (new `BackgroundTasks.dismiss`) — an error nobody saw is the one outcome worth insisting on.
  - **The dock mounts collapsed**, and deliberately isn't persisted, so it's collapsed on _every_ mount rather than merely the first. It sat directly above the composer; the header badges already report the live count and total, which is the whole of what a glance needs.
  - **Plan Review can open beside the conversation.** The narrow step-progress rail is gone — it could only ever be a lossy restatement of Plan Review in a column too small to act on. A split toggle in the tab bar now renders the real thing to the right of the transcript, resizable and persisted. The conversation and plan already shared one machine, so this is a layout change, not a lifecycle one: toggling it cannot remount or abort a live run.
  - **Review findings show the commit that fixed them.** Nothing asks the agent which finding a commit closes, so attribution is inferred: the first commit landed after the reviewed head that touches the finding's own path. Deliberately conservative — pathless findings never resolve, already-resolved findings are never re-attributed, and the card names the SHA so the claim can be checked rather than trusted. A resolved card recedes, strikes its title, reads "Resolved in `<sha>`", and stops counting toward its file's feedback badge.
  - **The pull request page gained its description.** `pr.body` was fetched, mapped and carried in the schema from the start and simply never drawn, so the tab opened straight onto the review timeline — the case _for_ the change missing from the page reviewing it. It now renders as the opening comment it is, inside the same 760px reading column as the Conversation view, so switching tabs no longer moves the text you were reading.
  - **Merging offers a strategy.** `PrMergeMethod` and `gh pr merge --<method>` supported merge/squash/rebase all along; only the UI didn't, so every merge from here was a merge commit. The button re-labels with the choice, because these are not interchangeable.
  - **An out-of-date branch offers "Update branch".** `mergeStateStatus` was only ever collapsed into a blocker _string_, so the box stated the problem and offered nothing. Being behind is the one blocker clearable from here. It updates the remote head only — never the worktree, since the agent may be mid-turn with uncommitted work.
  - **A passing check links to its run.** The details link was failures-only, making a green check a dead end; duration and details are no longer alternatives.

- 9e2539d: Adversarial review findings now act on themselves: the serious ones go to the working agent automatically, the small ones go on the pull request.

  - **Critical and major findings are sent to the session's agent automatically**, as one batched turn through the session's conversation (so its work and any approval gates surface in the Conversation tab). No click. This fires for background sessions too — a reviewer that finds a data-loss bug on a session you aren't looking at now reaches its agent. The prompt tells the agent to assess each finding and push back rather than change correct code: the reviewer is asked to argue _against_ the diff and report even what it doubts, so with nobody clicking Send, that instruction is what stands between a false positive and an unsupervised "fix".
  - **Minor and nit findings are posted to the pull request** as one review with inline, line-anchored comments — new plumbing (`gh` could only post a top-level comment or a body-only review before). Anchors are checked against the diff first: GitHub rejects an _entire_ review if one comment names a line outside it, so a finding the model mis-anchored folds into the review body instead of taking every other nit down with it. Posting is best-effort — a `gh` failure records itself on the review rather than discarding findings that cost real tokens.
  - **Routing and posting are stamped on the stored review** (`routedAt` / `postedAt` / `postError`), so they survive a reload. Without that the auto-review poll would hand the same review back after a restart and re-send the whole batch to the agent, every time.
  - **The file list marks which files carry feedback** — an icon and a count spanning adversarial findings, your unsubmitted drafts, and unresolved PR threads — and filters down to just those. (The old `commentCount` badge was hardcoded to 0 at every producer and could never render.)
  - **Finding cards redesigned** — severity as a coloured rail rather than a badge per row, so the worst-first ranking reads before the words do; and each card now reports its own outcome ("Sent to agent" / "Posted to PR") instead of offering an action that already happened. The manual send survives as a fallback for the cases automation can't reach.

- e7d7923: Run several sessions at once in a preset grid. Drag any sidebar row onto a pane to place it there, and pick a shape from the title bar: single, `1|1`, `2|1`, `1|2`, or `2|2` (each number is how many panes are stacked in that column). Sidebar rows badge the pane they occupy, each pane keeps its own tab, and the layout survives a restart.
- b419734: Stop a running agent for real, search the model list, and plan steps that survive the parser.

  - **Plan progress no longer dies after the turn that proposed the plan.** A `Plan` part lives permanently in the assistant message of the turn it was proposed in, but every run gets a fresh accumulator — so `markPlanProgress` looked for the approved plan in _this_ turn's message, found nothing, and returned. Progress could only ever accrue during the single run where the plan was proposed and approved; every step implemented on a later turn stayed unticked forever. Two more defects sat behind it: `applyPlan` persisted via `patchLast` (the newest message, not the plan's), and the renderer folded `PlanUpdated` with `patchLast` too, so even a correct update landed on a message holding no plan. The runner now locates a plan across the whole transcript (`findApprovedPlan`) and addresses its own message (`TranscriptStore.patchById`); the renderer folds `PlanUpdated` by plan id. This also fixes the out-of-band comment/revise/approve RPCs, which shared the same assumption.
  - **A step's file matching is anchored at a path separator.** The old suffix match was unanchored in both directions, so an edit to `a.ts` matched a step that declared `src/schema.ts` and ticked it — progress attributed to a step that had nothing to do with the change.
  - **Stop actually stops the agent.** There is a Stop button (it replaces Send while the agent works) and Escape does the same from outside the composer. The button is the smaller half of this: `AgentRunner.stop` only ever denied _pending_ gates/questions/plans, which is a no-op for an agent mid-stream and blocked on nobody — the case a stop button exists for. `CliAdapter.stop` is a stub in every implementation and is called by nothing, and a client hanging up its RPC stream does **not** tear the run down (verified). The only thing that reaches the CLI process is interrupting the run fiber, which fires the Claude adapter's `onInterrupt` → `abort()`. The runner now holds each run's fiber and interrupts it, so before this every Stop (and every "send now") left a zombie agent running in the main process. Stop still denies pending prompts first — the code that clears that bookkeeping sits after the `Deferred.await` an interrupt would kill — then interrupts, and `Fiber.interrupt` awaits the finalizers, so the call returns only once the agent is genuinely stopped.
  - **A halted turn settles instead of spinning forever.** An interrupt records `Stopped.` as the turn's terminal event rather than reporting the operator's own stop as "the agent run failed". The renderer can't wait for that event — `STOP` leaves the `running` state, which is the only place stream events are handled — so it folds the same note optimistically, from a shared constant, keeping the live view and a reloaded transcript in agreement.
  - **Known gap:** a stop landing during a run's pre-fork setup (session load + CLI discovery) finds no fiber and no-ops, so the agent starts. It's narrow — you'd have to hit stop within a tenth of a second of sending — and self-evident, since the run visibly continues and a second stop lands. Closing it means forking before the setup so the setup itself is interruptible. A session-level "stopping" flag was tried and rejected: a stop arriving with no run in flight is indistinguishable from a stale one, so honouring it would kill the operator's _next_ turn instead.
  - **The model chip filters.** It matches a model's name _or_ its harness heading, so "codex" surfaces a whole provider's models and "opus" finds the one; the box takes focus on open and ↵ picks the top match. Sections stay headed while filtered, so a narrowed list still says which harness you're about to switch to. Only the model chip gets it — the mode chip is four fixed options. Radix's menu implements typeahead (a bare letter jumps between items), which would rip the caret out of a filter box, so ordinary keystrokes are kept out of the menu while Up/Down/Escape/Tab still reach it.
  - **Fixed: the plan parser was shredding the steps it rendered.** Field values split on `/[;,]/` — commas _and_ semicolons — though the format documents these fields as semicolon-separated precisely because their values are prose and code. `meetsMinVersion(raw, min)` rendered as two approach steps, `"…meetsMinVersion(raw"` and `"min)"`. Worse, it hit guards: "Refresh fires at most once, even on repeated 401s" became two entries, the second asserting nothing — acceptance criteria quietly turned into noise. Prose fields now split on `;` only; ordinal lists (`depends`/`blocks`) keep comma tolerance, where a comma can't be part of a value.
  - **You can always see which file is being written.** A tool card's target is an absolute path inside the session's worktree, so the first ~60 characters are identical on every card — and `truncate` ellipsises the _tail_, which threw away the only part anyone reads. A path target now renders as a dim directory that gives way and a filename that doesn't, so the filename survives however deep the path. A Bash command is no longer treated as a path either: it keeps its head (where the command is) and stops being given a file glyph it never earned.
  - **Click a tool call to see what it actually did.** Bash, Grep and friends had nothing to expand — the adapter reduced every non-`Read` result to `null` and discarded the output entirely. Their results are now captured onto the card, and the header opens to show the whole command plus what it printed. Edit cards are untouched: their change is already spelled out by the diff peek, so storing the "ok" ack would cost transcript size on every edit and add nothing. A backgrounded Task is excluded for a sharper reason — its result is a launch ack ("Async agent launched successfully") that lands ~150ms in while the agent runs for minutes and reports into its own tab, so showing it as "output" would say the opposite of what's happening.
  - **Output is capped at both ends.** It rides the RPC and is persisted into `transcripts.json`, which every future read pays for, so a full `pnpm test` log can't go in whole. Which end matters depends on the command — a compile error leads with its failures, a test run closes with the summary that explains them — so the head and the tail both survive and the card says how much was dropped, rather than cutting silently and reading as "that's all it printed".
  - **`ToolCall.output` is optional, deliberately.** This schema decodes every transcript ever written, and `TranscriptStore.readAll` turns a decode failure into an _empty_ transcript — so adding the field as required would have silently erased the history of every existing session the first time it was opened. There's a test pinning that.
  - **The `/` menu now lists what the harness actually has — including `/goal`.** It was served a hardcoded list of five commands, and checked against the real CLI, three of them (`/plan`, `/test`, `/commit`) do not exist and never have: picking one sent text that did nothing. Meanwhile ~130 real commands were hidden — `/goal`, `/init`, `/compact`, `/model`, `/context`, `/security-review`. Codex fared worse: non-Claude harnesses were served _only_ that list, so their menu was entirely fiction. The CLI announces its whole surface (`slash_commands`, `skills`, `plugins`) on its `system/init` message and nowhere else — there's no `--list-commands` — so we start a query and read the announcement. It costs no model turn: `init` is emitted while the CLI boots, before the prompt is looked at (measured: hooks at ~2.1s, init at ~2.2s, nothing from the model in between), and we stop reading there. Names now come from the harness and are authoritative; descriptions layer on afterwards, from the skill's own frontmatter first and a gloss map for the built-ins second. That split is the point — a gloss can't conjure a command, which is exactly how `/test` and `/commit` got in. Non-Claude harnesses now report nothing until their own reporters land: an empty menu is at least true.
  - **A skill invocation says which skill.** `Skill` calls rendered as a bare "Skill" with nothing after it — `toolTarget` had no case for the tool, so its `skill`/`args` matched nothing and the target came out null. The one thing the card needed to say was the thing it left out.
  - **Fixed: a stop could be silently disarmed by the run it replaced.** A session's fiber was deregistered by session id, but the slot can already belong to a NEWER run by the time an older one finishes — "send now" interrupts the current turn and starts the next without waiting for the stop to land, so the two overlap. The older run's cleanup would evict the new run's fiber, and the next stop would find nothing and quietly do nothing, leaving a turn nobody could halt. Deregistration is now by run identity.
  - **Fixed: `depends: 01; blocks: 03` lost its second half.** The format spec puts both relations on one line, but the parser read the whole remainder as `depends` — yielding `dependsOn: ["01", "blocks: 03"]` and no `blocks` at all. Both bugs survived because the fixture avoided commas and wrote the relations on separate lines: it tested a shape the agent is never told to emit. The new cases are built from the format the agent is actually handed.

- f987c20: Background tasks are visible and stoppable, session transcripts survive a mid-write kill, and a merged PR no longer retires a live session.

  ## Background tasks

  Work the agent starts that **outlives the turn that started it** — a backgrounded shell command or sub-agent — previously ran to completion with nothing in the UI to say it existed, let alone stop it. It now gets a dock below the conversation with per-row **Stop** and **View**.

  - **The lifecycle is a statechart** (`backgroundTaskMachine`), not ad-hoc status branching. The harness's signals are unordered and lossy by design: `background_tasks_changed` is a _level_ signal whose ordering against the start/progress/settle _edges_ is explicitly unspecified, settle bookends can be dropped, and progress can arrive after a task has finished. States are `running → stopping → completed | stopped | failed`, with terminal states as XState `final` so a late progress report or a task reappearing in the level cannot resurrect it.
  - **`stopping` is a real state.** Stopping is not instant — the harness confirms via a later bookend — so without it the Stop button reads as broken. The row flips on the click and disables until the harness settles it either way.
  - **The level signal is authoritative for membership.** A task that vanishes from the live set is settled even with no bookend (otherwise a dropped edge wedges a row as "running" forever); a task _in_ the level we never saw start gets a placeholder row (better a vague row than invisible running work).
  - **A stop racing a natural completion reports the truth.** If a task finishes on its own between the click and the confirmation, it settles as `completed`, not `stopped`.
  - **State lives in a main-process registry**, one actor per task, keyed by session — _not_ in the renderer's conversation state, which is per-run and cleared on the next turn. Holding it there would delete the row the moment the next prompt was sent while the work carried on. Deliberately not disk-persisted: a background task cannot outlive its harness process, so a restored row could never settle and its id would resolve to nothing stoppable.
  - **Cross-provider by capability, not by pretence.** `CliInfo.backgroundTasks` gates the dock. Only Claude exposes real background tasks (a live set, per-task progress, and `query.stopTask`); Codex and OpenCode can only abort a whole turn, so they show no dock rather than a Stop button with nothing to aim at.
  - The Claude adapter now maps `task_started` / `task_progress` / `task_notification` / `background_tasks_changed`, which were previously dropped. `task_started` fires for **foreground** tasks too, so the level signal gates promotion — otherwise the dock would fill with ordinary synchronous sub-agents.

  ## Session history survived a mid-write kill

  **Fixed: a dev restart could zero a session's transcript**, and the conversation pane came back blank with no error. `TranscriptStore` wrote with `writeFileString`, which truncates the target before writing, and `AgentRunner` rewrites the whole file on nearly every stream event — so killing the main process mid-write (exactly what an electron-vite dev restart does) left a 0-byte file. Reads treat an unreadable transcript as "no history yet", which is why it presented as a silent blank rather than a failure. Writes now go to a scratch file and `rename` onto the target, which is atomic within a filesystem.

  A recovery script (`apps/desktop/scripts/backfill-transcript.ts`) rebuilds a lost transcript from the harness's own JSONL log by replaying it through the same `streamEventsFor` + `applyStreamEvent` path a live run uses. Note that agent _reasoning_ is unrecoverable — Claude's logs record thinking blocks with an empty string and a signature only.

  ## A merged PR no longer archives its session

  **Fixed: a session vanished from the sidebar when its linked PR merged.** A session record holds a single `prNumber` but routinely outlives several PRs (open one, merge it, keep working off the same worktree, open the next), so merging the first PR retired a session whose work was still in flight. Merge state now **badges** the row; archiving is always the operator's call. The `closeOnMerge` issue automation is unaffected — closing a linked issue is a statement about the issue, not about whether the session is finished.

  **Fixed: the Archived group sorted by `updatedAt`**, so a session archived today whose last turn was a week ago sorted below sessions archived days earlier — buried exactly when you go looking for it. It now sorts by `archivedAt`.

  ## Local DX

  The Playwright e2e suite no longer steals focus. It launches a real Electron app dozens of times, and every `show()` pulled focus from whatever you were doing, making the suite (which runs only locally — it is not in CI) incompatible with using the machine. Windows are now hidden and off the dock by default; `JINGLER_E2E_HEADED=1` to watch a run.

- 62cbb8a: VS Code-compatible colour themes.

  Nine themes ship built in — One Dark Pro (the default), Dark Modern, Light
  Modern, Monokai, Abyss, Tomorrow Night Blue, Solarized Dark, Solarized Light and
  High Contrast Dark. Pick one in Settings › Themes, where every entry previews
  itself in its own colours rather than just naming itself.

  Bring your own: any VS Code theme JSON works. Paste one from a marketplace
  extension into the import box, or drop a file into `~/jingler/themes/`. Edit
  that file in your own editor and the app repaints as you save. Keys Jingler does
  not use are preserved, so the file stays usable in VS Code.

  Duplicate any theme to get an editable copy with a colour picker for the values
  that carry a theme's character — surfaces, the text ramp, the accent ramp.

  The whole app follows the theme, including the terminal and diff syntax
  highlighting, and it is painted correctly on the very first frame rather than
  flashing dark before catching up. Choosing One Dark Pro is pixel-identical to
  how the app looked before.

### Patch Changes

- 20971db: Compact Codex conversations before an agentic turn can exhaust the model window.

  The context policy now reserves 25% of the reported window, a context-overflow
  failure forces recovery digest preparation even though the failed turn has no
  terminal usage event, retries wait for that recovery digest before resuming the
  full thread, and conversations retain their persisted context reading while a
  turn is active so the context meter remains visible.

- 9d25d60: Fix provider logos never loading in the app, and the grid rendering as a single column.

  Two defects that only appeared in the packaged renderer, both invisible to the test and Storybook loops that signed the feature off.

  **Logos.** The favicon URL the Connector Center builds — `https://www.google.com/s2/favicons?domain=…` — answers **301** and redirects to `t{0..3}.gstatic.com`. CSP is enforced against the redirect _target_, so an `img-src` allowing only `www.google.com` blocked every logo. `ConnectorLogo` treats a blocked image as a load error and falls back to an initial-letter tile, so nothing threw and nothing logged: the grid quietly showed letters where 1,100 brand marks should be. `img-src` now allows `https://*.gstatic.com` too, and a test asserts both origins are present — Storybook has no CSP, so a string check on the policy is the only cheap thing that could have caught this.

  **Columns.** Settings hands the catalog about 558px. The two-column threshold was derived from a 280px card, putting it at 568 — ten pixels above what the pane actually has, so the grid rendered one card per row in the only place it ships. The card minimum is now 240px (two columns from 488px), and the threshold test pins 558 → 2 explicitly rather than only testing round numbers.

- d5c8b6f: Fixed: the context meter, the Compact now button and automatic compaction had all silently stopped working.

  `ContextManager.bind` collided with `Function.prototype.bind`.

  `Effect.Service(..., { accessors: true })` hangs the generated accessors off the class. A class is a function object, so `bind` was already taken and the accessor was never created — every `ContextManager.bind(chatId, sessionId)` resolved to the built-in and returned a _bound copy of the class_ rather than an Effect. That copy still inherits the Tag's static `pipe` and `[Symbol.iterator]`, so `.pipe(...)` and `yield*` both kept type-checking and kept executing, and nothing ever threw. The call was simply a no-op, at all three sites: `Context.state`, `Context.compactNow`, and the agent runner.

  The consequence was total rather than partial, which is what made it hard to spot as a bug rather than a design. With `owners` never populated, `ownerOf` fell through to the chat id, `SessionStore.get` was handed `c_<id>_1` instead of a session id and failed, and `settingsFor` returned null. Every snapshot then came back with `window: null` — and a null window is a legitimate, well-handled state everywhere downstream, meaning `ContextMeter` renders nothing at all, the Compact now button never exists, and `auto` is false so no session ever compacts on its own. A feature that had degraded exactly the way it was designed to degrade when a harness reports nothing.

  The method is now `bindContext`.

  It escaped the unit suite because every existing test drives the manager with the same id for both the session and the chat — the legacy one-chat shape, where `ownerOf` falls through to the id it was handed and is right by accident, so the binding is never exercised. The new `chat-scoped context` tests use a distinct chat id: one asserts a bound chat resolves to a real window and trigger point, and a negative control asserts an _unbound_ chat reports an unknown window, so the pair proves the binding rather than merely that a window can be computed. The first fails with the old name — `expected null to be 200000`.

  Diagnosis is worth recording, because reading the code did not find it: the wiring is correct at every layer and typechecks clean. It took probing the live app — `tokens=42100`, `triggerAt=null` in the renderer, then `settingsNull=true` and `ownerId=c_s_ctx_1` inside the manager, then `bind=undefined` proving the binder's body never ran while the handler around it did.

- ec9c8c8: Fix a dead composer on session open — a prompt typed while a session loaded did nothing at all.

  `Skills.list` asks the harness what commands it has, which means spawning the binary: hundreds of ms to seconds. That call sat inside the conversation's `loading` step, which handles almost no events — so for as long as the probe took, the composer looked alive but swallowed everything: the send vanished, Shift+Tab did nothing, and picking a model snapped the chip straight back.

  The model catalogue already carried a comment warning about precisely this ("gating the transcript on a CLI probe would widen that hole from imperceptible to seconds"), so skills now get the treatment the catalogue already had: fetched out of band, applied when they land, blocking nothing. The `/` menu fills itself in a beat later.

  Three follow-ons, because a window that swallows input is only really closed when nothing can fall into it:

  - **A prompt sent before the transcript lands is now held and run**, exactly as a send during a run is. Dropping one was invisible — the box clears and you believe you sent it — and it survives a _failed_ load too: losing the transcript is no reason to also lose what you typed.
  - **A mode or harness picked mid-load is honoured** rather than dropped.
  - **The skills probe honours `JINGLER_SCRIPTED_AGENT`.** That switch means "spawn no real harness", and the probe ignored it — so the e2e suite was starting the operator's real `claude`, with their real login, on every launch. It now answers for the fake harness instead, which is what made the suite depend on which CLIs the host happened to have installed.

- 99ec277: Fixed: spawned processes could inherit the app's working directory and act on the wrong repository.

  Jingler runs many repos side by side, each session in its own git worktree. Four spawn sites fell back to the Electron main process's cwd when no worktree was supplied — and in development that cwd is whichever worktree `pnpm dev` was launched from. So a process belonging to repo A silently read and wrote inside repo B.

  This was not hypothetical. A user-scope MCP server probed from Settings (which has no session, so no worktree) was spawned with no `cwd`, inherited the app's, and created its SQLite database inside an unrelated repo's checkout — where it then surfaced as an untracked file in that repo's PR.

  - **MCP probe** (`mcp-probe.ts`) omitted `cwd` entirely when there was no worktree. It now always passes one: the session's worktree, or an explicitly neutral directory.
  - **Terminals** used `input.cwd ?? process.cwd()`. A terminal with no session now opens in the user's home — where an interactive shell would start anyway — never in a checkout.
  - **All three agent adapters** (claude, codex, opencode) mapped `spec.cwd || undefined` to _no_ cwd, so a session with a missing worktree would have run the agent against Jingler's own source. They now call `requireWorktree`, which throws rather than inheriting: a session with no worktree has nothing legitimate to run.

  Worktree _creation_ was never affected — paths are namespaced `worktrees/<repo>/<slug>` and every git command runs against the owning repo. The containment gap was entirely on the execution side.

  Two comments in the codebase asserted the safe behaviour while the code did the opposite, and one test asserted the unsafe behaviour as a guarantee (`falls back to the process cwd for an unknown session`); all three are corrected.

- 256f5a0: Plugin system: a session-mutating SDK surface, and nine adversarial-review fixes.

  - **`useSessionActions().unlinkIssue`** — the built-in Issue tab offered "unlink" and the plugin that replaced it could not, because the SDK had no way to change a session at all. The RPC and its handler survived the migration while the button did not, so the capability vanished with nothing failing. The list is deliberately one item long: a plugin _decorates_ a session, it does not drive one, and an entry earns its place only by being something the operator can reach solely through the plugin that owns the concept.
  - **Label colours are back in the GitHub Issues tab.** `IssueLabelChip` was lost in the same migration and every label rendered as an identical neutral outline — which reads as "this issue has no colour coding" rather than "the port dropped a feature". The hex is parsed and re-emitted rather than interpolated, the same rule the theme mapper follows.
  - **A crashed plugin no longer re-mounts on every render.** Both error boundaries cleared their error when `children` changed identity, which sounds like "the subtree is new" and means "anything re-rendered" — the registry rebuilds that element every pass. A deterministically-throwing plugin was therefore cleared, re-mounted and thrown again on every tick of the session pane, flickering its own failure card and filling the console. The reset is now keyed on the plugin's `id@version` and the session id.
  - **`ctx.exec` no longer kills children instantly or corrupts stdout.** `timeoutMs: 0` (or a negative, or a `NaN` out of a parsed config) scheduled the SIGKILL for the next tick, so every command died with a timeout nobody asked for; those values are now read as unset. Separately, one truncation flag was shared across both streams and its marker only ever appended to stdout — so a command with a chatty stderr and a small valid JSON stdout came back with `… output truncated` glued to the JSON. The 120s ceiling is now documented on `ExecOptions` rather than silently clamping.
  - **A consent prompt no longer clobbers a concurrent revocation.** `getSession` read the grants file, awaited an operator-paced native dialog, then wrote a list computed from that stale read. A revoke performed while the prompt was open was silently undone — restoring access the operator had just taken away.

  Also: the extension-host bundle's filename is documented correctly in `electron.vite.config.ts` (`.js`, not `.mjs` — the stale comment described the exact bug it was meant to record), `build-bundled-plugins.mjs` can run on Windows, and `@jingler/ui` stops publishing the keybinding resolver until the dispatch half that would use it lands.

- f3b2944: Keep failed memory captures durably queued across transient service outages and add an in-app recovery action that retries the outbox without blocking navigation.
- 938dba4: Fixed: the renderer's memory footprint grew without bound over a long dev session, reaching 4.9GB.

  Measured on a renderer that had been up 2h20m: a 4.92GB footprint (5.05GB peak) against only 325MB resident — the other 4.6GB had been allocated, never touched again, and compressed. 3.4GB of it sat in 66,083 separate allocations. That shape is retention, not churn, and it had three sources.

  **Image attachments were kept at full resolution.** `readAttachment` read a pasted file straight through `readAsDataURL` with no dimension cap, so a Retina screenshot arrived at its native size — one sampled attachment was 3010×1882 — was persisted into the transcript at that size, and was then handed to an `<img>` as a `data:` URL to paint a 58px tile. Chromium decodes the whole bitmap to do that: ~22.7MB for that one image. Across a `~/jingler` home there were 185 attachments totalling 105MB of image bytes, and a single 44MB transcript turned out to be 29MB of base64 images — 66% of it. A `data:` URL can't be re-fetched smaller the way a network image can, and the bytes were already on disk, so the cap has to land at ingest: attachments are now downscaled to a 1568px longest edge before they are encoded. 1568 is the largest edge Anthropic's vision API works at — it downscales anything bigger itself — so the agent loses no detail it would have received. Anything the resize declines (a GIF, whose animation a canvas round-trip would destroy; an image already inside the cap; a re-encode that came out larger; a host without the canvas APIs) falls through to the original bytes, so no attachment is lost to the optimisation.

  **Conversation actors were never evicted.** The registry keeps one actor per `session:chat`, hoisted out of React on purpose so a background session's agent keeps working while the operator looks at another. Nothing balanced that: an actor was only ever freed when its session was _deleted_ or its chat _closed_, so every session ever opened kept its whole parsed transcript and its full unified-diff patch string resident for the life of the app. Residency is now capped at six. The cap is deliberately timid, because the registry exists to protect work in flight: an actor is only evictable when it is idle, off-screen, holds no queued turns and no half-typed prompt — a live run, a queued turn and pending text exist _only_ in the actor, whereas the transcript is on disk and re-loads on the next visit. When every resident is busy the cap is simply exceeded; a memory target is not worth killing an agent's turn for. Eviction also leaves the evicted session's activity, plan presence and diff totals alone, because those describe the session rather than the actor — clearing them would make the Plan tab and the `+N −N` counters vanish from a session that still has both, purely because the operator looked at six others.

  **Derived state was re-computed per streamed token.** The actor's subscription fired on every delta, and each firing re-walked the entire transcript (`activityOf`, `latestPlan`), `JSON.stringify`'d the current plan, and re-derived the diff totals — the last of which called `patch.split("\n")`, allocating an array of every line of a multi-megabyte worktree diff, hundreds of times a second. Everything it published is sidebar furniture read at human speed, so publishing is now coalesced into one trailing flush per 100ms window, and `diffCounts` scans in place instead of splitting. Coalescing can't lose a settled transition — the last snapshot in a window is always the one flushed — only a state that appeared and vanished inside 100ms, which no operator could have acted on.

  The three fixes compound rather than overlap: the first shrinks what a transcript costs, the second bounds how many transcripts are held, and the third stops the size of a transcript being paid per token.

  An e2e spec covers the risk the cap introduces rather than the memory it saves: it visits nine sessions to push the earliest well past eviction, returns to the first, and asserts its history comes back intact and unmixed. That failure mode only appears past the cap, which is precisely the case nobody exercises by hand.

- 41f0d81: Fix a multi-gigabyte renderer on the Code Review tab, and a crash on quit.

  - **The Code Review tab no longer mounts the whole changeset at once.** `ReviewDiff` is non-virtualized — correct when the tab showed one file at a time, and quietly false once the continuous scroll stacked every file. Each line is about ten React fibers (row, two gutters, sign, one span per syntax token), so a 12.6k-line diff mounted half a million of them and held ~320MB; a real branch across two panes is where the multi-gigabyte renderer came from. Each file's lines now mount only near the viewport, with the file you're working in pinned so a half-written inline comment survives scrolling. Measured on that same diff: **321.9MB → 51.5MB**.
  - **Resizing the review pane no longer re-renders every line.** `DiffLine` was unmemoized with per-row handler closures, so every frame of a resize drag — and every step of a line selection — re-rendered all of them, allocating ~35MB per pass. It is now memoized behind stable handlers: six resize passes cost 0.7MB total.
  - **A diff changing under a mounted pane no longer retains the old one.** An agent editing files while the tab was open stepped the renderer up ~118MB and never gave it back.
  - **The app no longer aborts on quit with a terminal open.** PTYs were reclaimed through a promise, so `before-quit` returned and Electron tore the Node environment down with shells still running — node-pty's reader thread then fired a ThreadSafeFunction into an environment already in `CleanupHandles()`, which napi refuses and node-addon-api turns into an uncaught C++ exception. The crash reported as `SIGABRT` out of `pty.node`, looking like anything but "we quit with a shell open". They are now killed synchronously, listeners disposed first.

- b79346f: Sessions no longer come back with nothing to say. A turn that opened with a slash command — `/babysit-pr the PR we need it to main asap` — was rewritten before it reached the harness: the compaction primer and the saved-plan pointer were prepended, so the command was no longer the first thing in the message and the harness read it as prose rather than expanding it. The agent had nothing to do, the turn settled with zero parts, and the transcript showed a bare "CLAUDE" header with no reply. A turn that leads with a command now keeps it in front, and the context rides along after it.

  Two silent paths that produced the same empty block are closed as well. The Claude SDK's message stream can end without a `result` — a killed child, a crashed CLI, stdout EOF — and a `for await` that simply ends throws nothing, so the run emitted no terminal event at all; it now reports why it stopped. On the renderer side, the forked RPC stream swallowed transport failures entirely, and the conversation machine only leaves `running` on a `Done`/`Failed`, so a dead stream left the turn spinning forever (and reading as an empty assistant message after a reload). Every run now settles with exactly one terminal event, whatever happens to it.

  Plan mode stops asking permission for reads. Plan mode cannot write — the harness refuses edits outright — so every command it wanted approval for was a `git log`, an `rg`, a `gh pr view`: a queue of prompts for actions that could not change anything, which is how an operator learns to approve without reading. Commands now run unattended while planning, controlled by **Settings → General → Planning**. Edits gate exactly as before, in every mode.

  The conversation pill now says what the sidebar says. It rendered the raw activity ("Running npm test -- auth", "Searching the web"), so one session answered "what are you doing?" two different ways depending on where you looked, and the pill's width moved with every tool call. It reports one of the five words the rows use — Thinking, Running, Needs Input, Monitoring, Idle — with the specifics kept on hover.

- 304ac26: Stop losing turns, and make a compaction seamless to pick back up

  Three fixes, two of them for the same complaint: you send a message, the eyebrow
  appears, and the agent never answers.

  **A stop could kill the wrong run.** `AgentRunner.stop` read a session's in-flight
  run by session id alone, while the renderer fired `agentStop` and started the next
  turn without waiting. If the interrupt was scheduled after the new turn had been
  forked, it killed that instead — so a fresh message came back as a bare "Stopped."
  and had to be re-sent. 64 of 946 assistant turns in a local transcript archive
  were exactly this. A per-session lock now orders a stop against the next turn's
  setup, and the renderer waits in a new `stopping` state (capped at 3s) rather than
  firing and forgetting.

  **A wedged harness could hang forever, silently.** Nothing bounded the wait for a
  turn's first event: the renderer only synthesises a terminal event when a stream
  ends, and the runner's instrumentation is a finalizer, so a child that hung before
  saying anything was invisible everywhere and left the turn empty with the typing
  indicator running. 32 of those same 946 turns are frozen there. Turns that produce
  nothing for two minutes now settle with a message saying so.

  **Compaction now carries short-term memory.** The digest gained `recentWork` (what
  was just done, concretely) and `nextStep` (the single next action), rendered ahead
  of the backlog in the primer — so a compacted agent resumes mid-thread instead of
  re-planning from scratch. Older digests without these fields still decode.

  Separately: every agent is now told, each turn, to ask through its native question
  channel rather than in prose — a prose question renders as unanswerable chat text
  and gets silently ignored. Claude is pointed at `AskUserQuestion`; Codex gains a
  question channel it never had (it has no per-tool callback, so it asks through a
  fenced block that becomes the same question card).

- 736af33: Fix: talking to the main agent no longer kills its sub-agents.

  The Claude SDK backgrounds every `Task` by default, so a delegating turn's `result` arrives while its sub-agents are still working. Settling the turn there closed the input channel, which ended the **one** `query()` every sub-agent runs inside — and the runner then reaped the fiber, whose single `AbortController` took all of them down at once. Delegate five agents, say one more thing to the chat, and every tab died.

  A turn with live sub-agents is no longer treated as done. `runClaude` tracks outstanding sub-agents (added on `SubagentStarted`, released on the authoritative `task_notification` bookend, plus a leak guard for a `Task` that fails to launch) and withholds the turn's `Done` until the last one reports back — reusing the same hold-open machinery as the steer fix. Because the turn stays open, its steer handle stays registered too: a message sent while sub-agents work is pushed into the _same_ query rather than starting a second one that displaces the first.

  - **New `turn-continuation.ts`** — the "may this turn close?" decision as a pure, enumerable policy (following `run-lifetime.ts`): a `Failed` always closes, a pending steer outranks everything, live sub-agents hold the turn open, otherwise it is finished. It also selects the timer, because a steered continuation arrives in milliseconds while a sub-agent runs for minutes; the two cannot share one grace period.
  - **`SUBAGENT_LINGER_CAP` (10 minutes)** — a leak guard, not a grace period. A sub-agent whose bookend never arrives still settles the turn with its real `Done`, never the "ended without responding" failure.
  - **No change to `runLifetime`** — with the terminal event withheld, `turnSettled` stays false and the existing `turn-in-flight` rule keeps the run alive. Its tests now pin the two rows that depend on, so a later edit cannot quietly reopen this.
  - **Stop stays global.** One held-open turn is still one turn, so the Stop button halts the main agent and every sub-agent with it.

  Known gap, unchanged: closing the window mid-sub-agent still loses them (`abandoned-mid-turn` outranks everything), now asserted explicitly rather than left to be discovered.

- e820c43: Stop a reloaded window from wedging a chat on "already running"

  A chat could refuse every message forever with "This chat is already running.
  Wait for it to finish or stop it before sending again." — with nothing running,
  and no stop button on screen to clear it. Quitting and reopening the app was the
  only way out.

  The run reservation that backs single-flight is released by a finalizer on the
  run stream's scope, and that scope only closes three ways: a terminal event, a
  client `Interrupt` frame, or the RPC server being told the client disconnected.
  The third was never wired — `ServerProtocolLive` built a `disconnects` mailbox
  and nothing ever offered to it. So a renderer that dies without unmounting (a
  window reload, an electron-vite HMR full reload, a renderer crash) sent no
  interrupt and raised no disconnect. The main process, and the reservation map
  inside it, outlive the renderer — which is why a reload never cleared it and a
  quit always did.

  Fixed at both ends:

  - **The renderer's death is now reported.** `ServerProtocolLive` watches each
    `WebContents` for `destroyed`, `render-process-gone`, and cross-document main
    frame navigation (reload keeps the same `WebContents`, so nothing else marks
    the old page's requests dead), offering the client id to `disconnects`. The
    server then interrupts that client's in-flight handlers and their finalizers
    run — this releases far more than reservations.
  - **A stranded reservation is reclaimed rather than trusted.** A refusal now has
    to be backed by a live run: `fibers` is written under the same chat lock
    immediately after reserving, so "reserved, but no live fiber" is proof the
    reservation outlived its run, not a race. The belt to the first fix's braces —
    a reservation can only be as reliable as the scope that frees it, and this
    path no longer depends on one.

  A genuine double-send on a running chat is still refused; that test passes
  unchanged, and a new one covers the stranded case.

- Updated dependencies [256f5a0]
  - @jingler/plugin-sdk@2.0.0
