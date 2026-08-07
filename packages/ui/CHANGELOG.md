# @jingler/ui

## 2.0.1

### Patch Changes

- @jingler/contracts@2.0.1
- @jingler/core@2.0.1
- @jingler/themes@2.0.1

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

- 1c93bba: Rebuilt side-by-side sessions on Arc's group model: splits you build by dragging, not layouts you pick from a menu.

  The preset grid is gone. It asked the operator to choose a shape (`1`, `1|1`, `2|1`, `2|2`) from a title-bar picker and then fill its slots, which meant the shape and its contents were two separate decisions and an empty slot was a legitimate resting state — a pane showing "Drag a session here" was something the app could sit in indefinitely. Arc and Dia answer this differently, and the difference is the whole point: a split is not a layout with holes in it, it is _these sessions, side by side_. You make one by dragging a session next to another, and it exists exactly as long as it has two or more sessions in it.

  So the model is now a `Workspace` of `SplitGroup`s, each holding one to four panes with explicit width ratios (`packages/ui/src/app/split-layout.ts`, pure reducers). One sidebar row per group. **A group of one pane and a plain session are the same object** — there is no special case to render, because a lone session _is_ a one-pane group. That single fact is what removes the empty slot: closing the second-to-last pane leaves a group of one, which is an ordinary row.

  What that buys, concretely:

  - **Drag anywhere.** A session dropped on a pane's outer eighth inserts a pane on that side; dropped on the middle it replaces what's there. The edge zones are deliberately narrow — replacing is the commoner intent, and a wide edge means every casual drop splits when you meant to swap.
  - **One sidebar row per split**, rendered as Arc's pill: each pane a segment with its own status dot, title and close ×. At three panes and up the titles give way to dots (a 264px rail split four ways leaves ~50px a segment, which truncates "Refactor auth flow" to "R…"), and a hover peek card spells them out.
  - **Right-click a pill** for "Split with ▸" and "Separate all tabs" — Arc's own wording, reached the same way.
  - **Keyboard**, in one listener in `jingler-app.tsx`: `⌃⇧=` adds a pane, `⌃⇧1..4` focuses pane N, `⌃⇧[` / `⌃⇧]` move to the adjacent pane, `⌃⇧⌥←/→` move the focused _pane_, `⌃⇧W` closes it. Focus stops at the ends rather than wrapping — wrapping reads as a jump, and in a two-pane split it makes `[` and `]` indistinguishable.
  - **Dividers you drag**, with the ratios persisted. Panes trade width continuously; both neighbours clamp at 15% so a hard drag parks the divider instead of collapsing a pane to nothing.

  Motion (framer-motion v12) carries the transitions, with `MotionConfig reducedMotion="user"` at the app root so the whole thing honours the OS setting for free. Two things were learned the hard way and are commented where they bite: `layout` animation must be _off_ while a divider is being dragged (a spring chasing the pointer feels like elastic), and a `motion` element must wrap a draggable child rather than be one, or `motion` claims `onDragStart` for its own pan gesture.

  Existing arrangements are not lost. `sb.layout.v1` is read once and upgraded: the non-null slots become one group in column-major order, capped at four with equal ratios, focus preserved, written back as `sb.split.v2`.

  Also here, because the same drag work surfaced it: the New Session repo field is searchable. It moved from Radix `Select` to `ChipMenu`, because `Select` swallows every keystroke for its own typeahead and so cannot host a filter input at all.

  Deleted: `session-grid.tsx`, `layout-grid.ts`, `use-grid-layout.ts` and the title-bar `LayoutPicker`. The split is pure renderer state, exactly as the grid was — `packages/contracts`, `packages/cli-adapters` and the main process are untouched.

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

- 3dccb5c: Collapsed the session pane's tab chrome into one row of pills.

  A pane used to draw three ruled rows before a word of transcript: the session tabs (bordered full-height cells, a hairline between every one, a top accent on the active one), the chat strip (same again), and — the moment the agent spawned a `Task` — the sub-agent rail (same again, bottom accent). Four horizontal rules and around twenty vertical ones, all at full contrast, framing the one thing you opened the pane to read. Each row was defensible alone; the pile was not. And the third arrived _mid-turn_, so the pane gained a ruled row exactly when you were reading fastest.

  Two structural changes, not just a restyle:

  **There is no Conversation tab.** The session-name chip is it. The chip was already a permanent, unclickable label sitting immediately beside a tab that meant "show me this session" — two controls for one idea, one of which you couldn't click. Merged, it buys back the chip's width and drops the tab count from five to four. `TabKey` still carries `"conversation"`, because every machine, contract and test names the view that way; only its rendering moved.

  **The chat pills share the tab row**, behind a divider — `TabBar`'s new `chatSlot`. `ChatTabBar` is now a fragment rather than a strip, so it inherits the row's gap, alignment and _single_ horizontal scroll: chat pills and view tabs scroll together rather than as two half-rows. Chat state stays in the desktop renderer (RPCs plus live per-chat activity) and reaches the bar through a `renderChatTabs` render prop, so `@jingler/ui` never learns about the RPC client.

  Net effect: a pane mid-turn is two rows where it used to be three, and one horizontal rule where it used to be four.

  The row degrades in four tiers rather than clipping, and nothing is ever hidden behind a menu — a chat you can't see is a chat you forget is running:

  - the session title truncates at 210 → 150 → 92px, and at `tiny` becomes a status dot with the name on hover;
  - only the _selected_ view tab shows a label, and only from `mid` up — the row now competes with chat titles, and a chat title is the thing you actually read to tell two conversations apart;
  - the diff counts (`+681 −0`, up to seven tabular glyphs) collapse to a dot below `mid`;
  - inactive chat pills drop to dots at `tiny`; the active one always keeps its name;
  - sub-agent task descriptions go below `wide`, where they were already the pill's hover title.

  Every glyph keeps its `aria-label` and tooltip, so a by-name lookup — a screen reader, `getByRole("button", { name })`, the e2e suite — finds the same control at every width.

- a0292a3: Plan mode now runs on Codex and opencode, not just Claude.

  Plan mode was Claude-only for a real reason: it steers the harness toward `ExitPlanMode`, a tool the other two don't have. But the workaround was already in the codebase, shipping, twice. Adversarial planning reads its plans out of a fenced ` ```plan ` block precisely so any harness can hold any role, and structured questions do the same with a JSON block that `codex-adapter` parses out of an ordinary reply. This is the third use of a pattern that was already proven, not new machinery.

  So `planInstructions` is now a function of how the plan comes back — `"tool"` for Claude, `"reply"` for everyone else — and the grammar below that first sentence is byte-identical between the two, guarded by a test. A Codex plan is parsed by the same `parsePlan`, renders as the same interactive card, and takes the same comment/revise/approve flow.

  **A safety bug fell out of scoping this, and it's the load-bearing fix.** `mapCodexPolicy` branched `readOnly → auto → else`, so `plan` fell through to `workspace-write`, and `agent-runner` never sets `spec.readOnly`. Ungating the chip without touching that would have shipped a "planning" mode that edits your worktree. Plan mode's promise is that the agent _cannot_ write until you approve; on Claude the SDK keeps that promise, and on these two harnesses nothing was keeping it. Now Codex plans under a `read-only` sandbox and opencode plans with `edit`/`write`/`patch`/`task` withheld.

  The two harnesses get there differently, because their sandboxes have different lifetimes:

  - **Codex** fixes `sandboxMode` when the _thread_ opens, so approving a plan re-opens the same thread id under the restored exec mode. Same id, so the planning conversation is still there — a fresh thread would make the agent re-derive everything it just worked out.
  - **opencode** bakes its permission map into `OPENCODE_CONFIG_CONTENT` when the _server_ spawns, which a mid-run approval can't revoke without a restart. It uses `session.prompt`'s per-prompt `tools` map instead — stronger, because a withheld tool is never offered to the model at all, and there is no gate for an unanswered approval to park on. `bash` stays available in both: planning means reading the code, which is what Claude's own plan mode allows.

  Both adapters run the same bounded loop (six rounds): revise sends your comments back as the next prompt, approve re-prompts with the plan under a widened sandbox, reject ends the turn. Past the cap the block degrades to plain text — no card, no error, exactly what the question channel already does.

  The gate itself is now one predicate, `supportsPlanMode(cli)`. It replaces four separate `cli === "claude"` checks — the composer chip, the Shift+Tab cycle, and the renderer _and_ main-process coercions that fired on a harness switch — three of which drop the mode silently rather than erroring, so a disagreement between them looked like a bug with no message. A consequence worth knowing: switching Claude → Codex mid-plan no longer throws your planning session away.

  One cost, and it's visible. Approval on Codex and opencode spends an extra harness turn, because the sandbox can only widen on a new prompt. Claude carries straight on inside one query.

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

- 9e2539d: The sidebar reports one of five states, and only those five: **Thinking**, **Running**, **Needs Input**, **Monitoring**, **Idle**.

  Before, a row could say almost anything. It showed the live activity's own label when one existed ("Running git branch --show-current", "Searching the web", "Delegating") and a lowercase persisted status when one didn't ("running", "idle") — so the same session named the same state differently depending on whether a tool happened to be in flight, and an unbounded command string ellipsized over the branch name beside it. Grouping by status introduced a third vocabulary again, calling it "Working".

  - **One rollup, `displayStatusOf`, now feeds the row's label, its colour, and its group header.** Every kind of tool work (reading, editing, web, delegating) reports Running — the conversation header keeps the finer distinction, where there's room for it. Both watchers (`gh pr checks --watch` and `vitest --watch`) report Monitoring: they differ in what they watch, not in what they mean here — a process that won't return. Needing approval reports Needs Input, since there's one thing for the human to do about either.
  - **The detail moved to the row's hover title**, so "Running npm test -- auth" is still there when you want it and can't push the branch out of the row when you don't.
  - **Grouping by status now reads Needs Input / Running / Monitoring / Idle.** Monitoring earns its own group (a watch lasts minutes, so the group holds still). Thinking deliberately does not — it still folds into Running, because an agent flips between the two every few seconds and a group that reorders under your cursor is worse than a coarser one that doesn't. The row still says which.
  - **The unreachable "done" status folds to Idle.** It's in `SessionStatus` but nothing writes it (`SettledSessionStatus` is idle | needs-input), and its "Done" group could never appear.

- 8e9cb2a: Collapse the sidebar to an icon rail — on ⌘B, on a button, and with the session details one hover away.

  The sidebar could already become a 52px rail, but only by itself: it collapsed when the shell dropped below 1000px and there was no way to ask for it. The button that put it back lived _on the rail_, so the docked state had no control for leaving the docked state, and ⌘B was the only way out of it — a keystroke you had to already know about. There is now a `PanelLeft` button left of "Sessions" in the docked header and another at the top of the rail, so the same control sits in the same corner in both states and each one is the other's inverse. ⌘B still toggles, and the choice still persists (`sb.sidebar.pinned`) and still outranks the width rule in both directions.

  **Hovering the rail now tells you about one session rather than re-opening all of them.** Previously, resting anywhere on the rail for 150ms floated the _entire_ sidebar back over the content. One gesture, one very large answer — and it meant the rail's own cells could never say anything, because anything they said would be covered a moment later. Each cell is now its own `SessionHoverCard`: title, repo and branch, live status (the real activity line, "Running pnpm test -- auth", not the five-word rollup), diff stat, PR glyph and number, and relative age. Deliberately the same facts `SessionRow` shows and no more — a card that knew things the expanded sidebar didn't would make the two states disagree about what a session _is_. Read-only, too: archive and delete stay on the row, because a card you have to chase with the pointer to click is a card you will misclick.

  The card is `HoverCard` (`packages/ui/src/components/hover-card.tsx`), a thin wrapper over `@radix-ui/react-tooltip` — already a dependency, previously unused. Five things it supplies that a hand-rolled absolute-positioned card would each have had to reimplement: collision flipping (the rail hugs the left edge and its cells run to the bottom), portalling out of the rail's `overflow-y-auto` scroller, a delay primitive, Escape-to-dismiss, and opening on keyboard focus — which is both the accessibility story and the only way jsdom can drive the thing in a test, having no pointer that can rest.

  **The rail cell shows the harness, not initials.** Two letters of an auto-generated title said nothing you didn't know ("UN" for Untitled), and two sessions on one feature collided; which agent is driving is the fact you actually navigate by, so the cell is now a `ProviderIcon` — brand-coloured for the active session, monochrome for the rest, so the rail reads as one selected thing among peers rather than a row of competing logos.

  **And the active cell now looks selected.** It was a half-opacity blue ring over a surface fill: two low-contrast signals at 32px, against a panel of nearly the same value, which together read as "slightly smudged". The ring is gone (a ring and a bar both claiming selection is one signal too many) in favour of a 3px accent bar on the rail's left edge — 32px of cell centred in 52px of rail leaves exactly 10px, so it lands on the panel border where every editor puts it — over the same `bg-surface` fill `SessionRow` uses, so a session looks selected the same way in both sidebar states.

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

### Patch Changes

- c1a3c18: Compaction stops firing eagerly, waits for a boundary, and reports honest numbers.

  Four faults on one path, all visible in the same corner of the screen.

  **The reading survived the reseed.** Applying a digest starts a brand-new harness
  conversation, but the manager kept the occupancy reading that described the old
  one — in memory and on disk. The meter therefore read "compacting soon" over a
  40k session, and the next turn's decision measured a conversation that no longer
  existed and forked another digest. Both copies are now cleared at the swap.

  **The marker quoted the wrong number.** The in-transcript "Context compacted
  from …" line was reading `Session.tokens`, the session's lifetime spend, so a
  long-running session announced "from 49894.2k" — larger than any context window
  in existence. It now comes from the manager's own occupancy reading. Markers
  already written carry the old figure, so the divider declines to quote anything
  implausible rather than showing it.

  **Modern Opus was measured as a 200k model.** `claude-opus-4-8` matched the bare
  `opus` row in the model-id table, putting the trigger at 170k — so sessions the
  harness was happily running at 500k sat permanently on "compacting soon".
  Opus 4.5+ now reads as 1M, and beyond the table any window a session has
  demonstrably exceeded is corrected upward: a reading of 598k is proof the
  ceiling is not 200k, whatever the guess said. The working-set budget also moves
  to 400k (tunable to 500k), which is where the current generation of models
  actually starts to degrade.

  **Compaction could land mid-task.** A swap dropped into an unfinished edit
  sequence or a live debugging thread discards exactly the state the next turn
  needs. The digest run — which already reads the whole transcript on the cheap
  tier — now also reports whether the session is mid-flow, and that combines with
  structural evidence a summary cannot see: a plan still executing, an unanswered
  question, a pending approval, a background task still running. When it is, the
  swap is held for a turn and the meter says "compaction held" with the reason.
  The digest is never discarded, and the hold yields to the hard ceiling and to a
  three-turn cap, so a session that always looks busy still compacts.

- df17817: Retune the composer toolbar's trailing end: the branch now rides beside send, and send/stop are icon buttons.

  The branch used to lead the row, next to the model chip. But "where is this about to land?" is a question you ask at the moment you send, not while picking a model — so it now sits immediately before the send button, still truncating first when the row is squeezed since it is the only control there that can lose characters and stay useful.

  Send and stop dropped their text for an arrow and a stop square. Icon-only means `aria-label` is now the sole accessible name — the labels are preserved (`Send ↵`, `Queue ↵`, `Stop`) so existing selectors and screen readers still find them.

  Reasoning strength swapped its brain glyph for cell-service signal bars, filled one rung per step of the harness's own ladder. A brain said "thinking" and nothing about how much; bars carry the magnitude at a glance. The scale is the provider's, not a fixed one — Claude runs low…max and Codex minimal…xhigh, so "high" is 3 of 5 bars on one and 4 of 5 on the other. Neither `default` nor `off` fills a bar (neither is a strength); `off` is told apart by a slash through the ramp.

- d6dbd48: Rebuild Settings › Connectors as a logo grid with a per-provider detail sheet, and fix the three catalog-mapping bugs the redesign exposed.

  The catalog was a flat 52px list of ~1,100 rows with a first-initial tile where a logo should be. It is now a virtualized grid of cards — brand logo, auth-mode chips, category, and a status dot — with All / Connected / Not connected tabs whose counts re-scope to the active search and category filter, so a tab never promises a result it cannot show.

  Logos come from each provider's `homepageUrl` hostname through Google's favicon service, the same source OOMOL Connect's own Providers page uses. That indirection is not a shortcut: OpenConnector's catalog returns `iconUrl: null` for every one of its providers, and a homepage for every one. Providers with no parseable homepage, and any favicon that fails to load, fall back to the initial tile. This widens the renderer's CSP `img-src` to allow `https://www.google.com` — images only.

  Clicking a card now opens a detail sheet carrying the provider's real connect form, fetched one provider at a time from `GET /api/providers/{service}` behind a new `Connector.provider` RPC. Per-provider on purpose: the endpoint that returns every provider's fields at once inlines each action's JSON Schema and weighs ~5 MB. Before this, the catalog list response carried no auth fields at all, so _every_ provider fell through to a single generic "API key" box — Linear's `lin_api_…` placeholder, Notion's "Internal Integration Secret" label and every custom-credential provider's multi-field form were all unreachable. Providers offering both OAuth and a key now get a segmented control rather than one form stacked above the other, and the sheet lists the OAuth scopes the grant will request.

  Three data bugs went with it, each pinned by a test using a payload captured from a live instance:

  - `no_auth` was missing from the auth-type union. Since an unrecognised type is indistinguishable from an unknown one, the mapper defaulted those providers to `api_key` and put a credential form in front of the handful (arXiv, Hacker News, Docsend2pdf) that take no credential and arrive already usable. They now read "No auth needed — ready to use".
  - Connections were read at the wrong nesting level. The instance nests the account under `profile`; the mapper looked for `accountId`/`displayName`/`grantedScopes` at the root, so every connected row rendered a blank account and zero scopes — a silent empty, not an error.
  - Providers offering a _choice_ of credential form could not be connected at all. Elasticsearch takes either an encoded API key or a username/password pair, each alongside its own `baseUrl`; the three such providers in the catalog had both descriptors flattened into one form, which demanded every field of both alternatives, carried `baseUrl` twice, and submitted under a single `authType`. The instance rejects a field the chosen type never declared — `Unexpected credential field: apiKey.` — so the request always failed. `ConnectorProviderDetail` now carries `keyModes`, one form per mode, each a tab submitting under its own `authType`.
  - "Add another connection" destroyed the one you had. `PUT /api/connections/{service}` is create-or-_replace_, and the name field arrived pre-filled `default` — so adding a second account for a provider silently overwrote the first account's credential, under a heading promising the opposite. The field now starts blank when a connection already exists and will not submit until it is named, and a name that collides with an existing connection warns that it will replace that credential rather than blocking it (rotating an expired key is exactly this operation).
  - A `no_auth` provider's connection offered a Disconnect button that could not work. The instance lists those as `virtual` — nothing is stored, so there is nothing to delete — and answers `DELETE` with 200 and `configured: true`, leaving the connection in place. The app reported success, refetched, and the row stayed: a destructive-looking control that visibly did nothing. `ConnectorConnection` now carries `removable`, and those rows show a "built in" chip instead.
  - The default connection had two spellings. The instance names it `"default"` on reads but documents the parameter as "defaults to default" on writes, so the read path carried the string while the write path omitted it — for the same record. `ConnectorConnection` documents null as the default, so the mapper now normalizes `"default"` to null and both paths agree. (Both forms resolve to the same connection on the instance, so this fixes an invariant rather than a failure.)

- 9d25d60: Fix provider logos never loading in the app, and the grid rendering as a single column.

  Two defects that only appeared in the packaged renderer, both invisible to the test and Storybook loops that signed the feature off.

  **Logos.** The favicon URL the Connector Center builds — `https://www.google.com/s2/favicons?domain=…` — answers **301** and redirects to `t{0..3}.gstatic.com`. CSP is enforced against the redirect _target_, so an `img-src` allowing only `www.google.com` blocked every logo. `ConnectorLogo` treats a blocked image as a load error and falls back to an initial-letter tile, so nothing threw and nothing logged: the grid quietly showed letters where 1,100 brand marks should be. `img-src` now allows `https://*.gstatic.com` too, and a test asserts both origins are present — Storybook has no CSP, so a string check on the policy is the only cheap thing that could have caught this.

  **Columns.** Settings hands the catalog about 558px. The two-column threshold was derived from a 280px card, putting it at 568 — ten pixels above what the pane actually has, so the grid rendered one card per row in the only place it ships. The card minimum is now 240px (two columns from 488px), and the threshold test pins 558 → 2 explicitly rather than only testing round numbers.

- eeaabe2: Fixed: conversation panes sized to their content instead of filling their slot, stranding the composer mid-pane.

  The grid slot added when sessions gained side-by-side layouts carried `min-h-0 min-w-0 flex-col` but no `flex-1`. Every wrapper above and below it was already `flex-1 min-h-0`, so height propagated the whole way down from `#root` and then stopped at the slot, which fell back to sizing itself to its content. The visible symptom was the message composer floating in the middle of a pane rather than pinned to its bottom edge — worst in a freshly-filled pane, where an empty transcript gives the slot almost no content to size to.

  The slot now takes `flex-1 basis-0` rather than bare `flex-1`. The `basis-0` matters for the stacked layouts (`2|1`, `1|2`, `2|2`): with `flex-1` alone the two slots in a split column grow from their _content_ heights, so a pane holding a long transcript and a pane holding an empty one divide the column unevenly. Starting both from zero makes them share it equally.

  Also added the `min-h-0` that `conversation-view` and `session-conversation` were missing, so a tall transcript hands off to its own `overflow-auto` scroller rather than depending on the slot's `overflow-hidden` to contain it.

  The new tests for this assert measured geometry — slot height against the grid container, composer bottom against its slot's — rather than behaviour. That is deliberate: the existing 91-test end-to-end suite passed throughout the bug's lifetime, because a pane rendered at half its height still holds the same sessions, answers the same clicks, and survives the same restarts. Layout regressions are only visible to assertions about boxes. All three new tests fail by 347px with the fix reverted.

- 42780c5: Stream Codex context usage during active turns and compact before GPT-5.6 sessions exhaust their effective window.
- 256f5a0: Plugin system: a session-mutating SDK surface, and nine adversarial-review fixes.

  - **`useSessionActions().unlinkIssue`** — the built-in Issue tab offered "unlink" and the plugin that replaced it could not, because the SDK had no way to change a session at all. The RPC and its handler survived the migration while the button did not, so the capability vanished with nothing failing. The list is deliberately one item long: a plugin _decorates_ a session, it does not drive one, and an entry earns its place only by being something the operator can reach solely through the plugin that owns the concept.
  - **Label colours are back in the GitHub Issues tab.** `IssueLabelChip` was lost in the same migration and every label rendered as an identical neutral outline — which reads as "this issue has no colour coding" rather than "the port dropped a feature". The hex is parsed and re-emitted rather than interpolated, the same rule the theme mapper follows.
  - **A crashed plugin no longer re-mounts on every render.** Both error boundaries cleared their error when `children` changed identity, which sounds like "the subtree is new" and means "anything re-rendered" — the registry rebuilds that element every pass. A deterministically-throwing plugin was therefore cleared, re-mounted and thrown again on every tick of the session pane, flickering its own failure card and filling the console. The reset is now keyed on the plugin's `id@version` and the session id.
  - **`ctx.exec` no longer kills children instantly or corrupts stdout.** `timeoutMs: 0` (or a negative, or a `NaN` out of a parsed config) scheduled the SIGKILL for the next tick, so every command died with a timeout nobody asked for; those values are now read as unset. Separately, one truncation flag was shared across both streams and its marker only ever appended to stdout — so a command with a chatty stderr and a small valid JSON stdout came back with `… output truncated` glued to the JSON. The 120s ceiling is now documented on `ExecOptions` rather than silently clamping.
  - **A consent prompt no longer clobbers a concurrent revocation.** `getSession` read the grants file, awaited an operator-paced native dialog, then wrote a list computed from that stale read. A revoke performed while the prompt was open was silently undone — restoring access the operator had just taken away.

  Also: the extension-host bundle's filename is documented correctly in `electron.vite.config.ts` (`.js`, not `.mjs` — the stale comment described the exact bug it was meant to record), `build-bundled-plugins.mjs` can run on Windows, and `@jingler/ui` stops publishing the keybinding resolver until the dispatch half that would use it lands.

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

- 9365e0c: A review belongs to one chat, and the sub-agent view drops its duplicate header.

  **The leak.** Open a session that has run an adversarial review, start a new chat, and the new chat immediately showed a `Reviewer — Adversarial review` pill in its sub-agent rail, replaying a run it had nothing to do with. `Review.watch` is session-scoped and replays its buffer (and the stored transcript) to every late subscriber, but each _chat_ runs its own conversation machine and every one of them subscribed. A session-level artifact rendered inside a chat's rail has to belong to exactly one chat, or every chat you create inherits it.

  A review is now owned by the chat that was the session's `activeChatId` at the instant the run **started** — stamped in the same place the buffer and transcript are reset for a new run, so ownership is fixed at birth and a later chat switch doesn't move it. `Review.watch` takes the subscriber's `chatId` and emits only to the owner. The owner is persisted with the transcript, so a restart brings the tab back in the right chat rather than in all of them; a transcript written before this change has no owner and stays visible everywhere, which is the old behaviour kept deliberately so an existing review doesn't vanish — it self-heals on the next run.

  **The duplicate header.** `SubagentView` drew a ruled row naming the agent, its task and a `WATCH-ONLY` lozenge — every word of which the selected pill in the rail immediately above already says, and the rule was a third horizontal line in a pane that had just been cut down to one. A label sitting directly beneath the identical label it repeats reads as two different things until you look twice. It's gone.

- b79346f: Sessions no longer come back with nothing to say. A turn that opened with a slash command — `/babysit-pr the PR we need it to main asap` — was rewritten before it reached the harness: the compaction primer and the saved-plan pointer were prepended, so the command was no longer the first thing in the message and the harness read it as prose rather than expanding it. The agent had nothing to do, the turn settled with zero parts, and the transcript showed a bare "CLAUDE" header with no reply. A turn that leads with a command now keeps it in front, and the context rides along after it.

  Two silent paths that produced the same empty block are closed as well. The Claude SDK's message stream can end without a `result` — a killed child, a crashed CLI, stdout EOF — and a `for await` that simply ends throws nothing, so the run emitted no terminal event at all; it now reports why it stopped. On the renderer side, the forked RPC stream swallowed transport failures entirely, and the conversation machine only leaves `running` on a `Done`/`Failed`, so a dead stream left the turn spinning forever (and reading as an empty assistant message after a reload). Every run now settles with exactly one terminal event, whatever happens to it.

  Plan mode stops asking permission for reads. Plan mode cannot write — the harness refuses edits outright — so every command it wanted approval for was a `git log`, an `rg`, a `gh pr view`: a queue of prompts for actions that could not change anything, which is how an operator learns to approve without reading. Commands now run unattended while planning, controlled by **Settings → General → Planning**. Edits gate exactly as before, in every mode.

  The conversation pill now says what the sidebar says. It rendered the raw activity ("Running npm test -- auth", "Searching the web"), so one session answered "what are you doing?" two different ways depending on where you looked, and the pill's width moved with every tool call. It reports one of the five words the rows use — Thinking, Running, Needs Input, Monitoring, Idle — with the specifics kept on hover.

- 304ac26: Move splits above the repo groups in the sidebar

  A split used to be drawn inside whichever repo group its first surviving pane
  landed in. That was defensible while a split meant two sessions from one repo —
  but you can split across repos, and then the pill claimed one repo as its home
  while the other repo's session had no entry of its own.

  Splits now sit in their own section directly under the filters, above every
  group, because a split belongs to no repo. Their member sessions are held out of
  the grouped lists before grouping, so a repo's count badge matches the rows
  under it and a repo whose only sessions are in a split no longer renders an
  empty heading.

- Updated dependencies [3deb8c2]
- Updated dependencies [fa256c7]
- Updated dependencies [f948464]
- Updated dependencies [1eed467]
- Updated dependencies [20971db]
- Updated dependencies [f8760cf]
- Updated dependencies [c1a3c18]
- Updated dependencies [d6dbd48]
- Updated dependencies [59305ae]
- Updated dependencies [272f34a]
- Updated dependencies [142c0fe]
- Updated dependencies [42780c5]
- Updated dependencies [f842e84]
- Updated dependencies [37c10d5]
- Updated dependencies [ce51af4]
- Updated dependencies [af42847]
- Updated dependencies [eb62eb6]
- Updated dependencies [f3bb880]
- Updated dependencies [d11dbf0]
- Updated dependencies [a0292a3]
- Updated dependencies [abec0fa]
- Updated dependencies [09f4690]
- Updated dependencies [334ebfc]
- Updated dependencies [f3b2944]
- Updated dependencies [777d6d2]
- Updated dependencies [9e2539d]
- Updated dependencies [9365e0c]
- Updated dependencies [9e2539d]
- Updated dependencies [b79346f]
- Updated dependencies [304ac26]
- Updated dependencies [b419734]
- Updated dependencies [f987c20]
- Updated dependencies [e98acda]
  - @jingler/contracts@2.0.0
  - @jingler/core@2.0.0
  - @jingler/themes@2.0.0
