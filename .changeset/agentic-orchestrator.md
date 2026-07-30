---
"@jingler/desktop": minor
"@jingler/cli-adapters": minor
"@jingler/contracts": minor
"@jingler/core": minor
"@jingler/ui": minor
---

Make the orchestrator agentic instead of scripted. It now speaks in one natural
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
