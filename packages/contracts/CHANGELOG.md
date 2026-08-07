# @jingler/contracts

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

- 9365e0c: A review belongs to one chat, and the sub-agent view drops its duplicate header.

  **The leak.** Open a session that has run an adversarial review, start a new chat, and the new chat immediately showed a `Reviewer — Adversarial review` pill in its sub-agent rail, replaying a run it had nothing to do with. `Review.watch` is session-scoped and replays its buffer (and the stored transcript) to every late subscriber, but each _chat_ runs its own conversation machine and every one of them subscribed. A session-level artifact rendered inside a chat's rail has to belong to exactly one chat, or every chat you create inherits it.

  A review is now owned by the chat that was the session's `activeChatId` at the instant the run **started** — stamped in the same place the buffer and transcript are reset for a new run, so ownership is fixed at birth and a later chat switch doesn't move it. `Review.watch` takes the subscriber's `chatId` and emits only to the owner. The owner is persisted with the transcript, so a restart brings the tab back in the right chat rather than in all of them; a transcript written before this change has no owner and stays visible everywhere, which is the old behaviour kept deliberately so an existing review doesn't vanish — it self-heals on the next run.

  **The duplicate header.** `SubagentView` drew a ruled row naming the agent, its task and a `WATCH-ONLY` lozenge — every word of which the selected pill in the rail immediately above already says, and the rule was a third horizontal line in a pane that had just been cut down to one. A label sitting directly beneath the identical label it repeats reads as two different things until you look twice. It's gone.

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

- f3b2944: Keep failed memory captures durably queued across transient service outages and add an in-app recovery action that retries the outbox without blocking navigation.
- b79346f: Sessions no longer come back with nothing to say. A turn that opened with a slash command — `/babysit-pr the PR we need it to main asap` — was rewritten before it reached the harness: the compaction primer and the saved-plan pointer were prepended, so the command was no longer the first thing in the message and the harness read it as prose rather than expanding it. The agent had nothing to do, the turn settled with zero parts, and the transcript showed a bare "CLAUDE" header with no reply. A turn that leads with a command now keeps it in front, and the context rides along after it.

  Two silent paths that produced the same empty block are closed as well. The Claude SDK's message stream can end without a `result` — a killed child, a crashed CLI, stdout EOF — and a `for await` that simply ends throws nothing, so the run emitted no terminal event at all; it now reports why it stopped. On the renderer side, the forked RPC stream swallowed transport failures entirely, and the conversation machine only leaves `running` on a `Done`/`Failed`, so a dead stream left the turn spinning forever (and reading as an empty assistant message after a reload). Every run now settles with exactly one terminal event, whatever happens to it.

  Plan mode stops asking permission for reads. Plan mode cannot write — the harness refuses edits outright — so every command it wanted approval for was a `git log`, an `rg`, a `gh pr view`: a queue of prompts for actions that could not change anything, which is how an operator learns to approve without reading. Commands now run unattended while planning, controlled by **Settings → General → Planning**. Edits gate exactly as before, in every mode.

  The conversation pill now says what the sidebar says. It rendered the raw activity ("Running npm test -- auth", "Searching the web"), so one session answered "what are you doing?" two different ways depending on where you looked, and the pill's width moved with every tool call. It reports one of the five words the rows use — Thinking, Running, Needs Input, Monitoring, Idle — with the specifics kept on hover.

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
- Updated dependencies [777d6d2]
- Updated dependencies [9e2539d]
- Updated dependencies [9e2539d]
- Updated dependencies [b79346f]
- Updated dependencies [304ac26]
- Updated dependencies [b419734]
- Updated dependencies [f987c20]
- Updated dependencies [e98acda]
  - @jingler/core@2.0.0
