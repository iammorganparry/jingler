---
"@jingler/cli-adapters": minor
"@jingler/desktop": minor
---

Run multiple chats in one session at the same time.

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
