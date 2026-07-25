---
"@starbase/cli-adapters": minor
"@starbase/desktop": minor
---

Run multiple chats in one session at the same time.

A session's chats share one git worktree, and the harness used to refuse a second
run while any run in the session was live — starting chat B while chat A worked
came back as "Another chat or plan in this session is running." That guard existed
to stop two agents mutating the shared worktree at once, but it also blocked the
common, safe case: a second chat reviewing, planning, or working a different
corner of the tree while the first runs.

The single-owner reservation is now a multi-owner one: it still reports whether
*anything* in the session is live (so the learning daemon backs off), but it never
gates a run. Like Conductor's shared-workspace mode, concurrent chats share the
worktree with no locking — conflicting edits are the operator's call, not the
harness's.

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
