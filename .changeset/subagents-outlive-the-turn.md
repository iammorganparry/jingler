---
"@starbase/cli-adapters": patch
"@starbase/desktop": patch
---

Fix: talking to the main agent no longer kills its sub-agents.

The Claude SDK backgrounds every `Task` by default, so a delegating turn's `result` arrives while its sub-agents are still working. Settling the turn there closed the input channel, which ended the **one** `query()` every sub-agent runs inside — and the runner then reaped the fiber, whose single `AbortController` took all of them down at once. Delegate five agents, say one more thing to the chat, and every tab died.

A turn with live sub-agents is no longer treated as done. `runClaude` tracks outstanding sub-agents (added on `SubagentStarted`, released on the authoritative `task_notification` bookend, plus a leak guard for a `Task` that fails to launch) and withholds the turn's `Done` until the last one reports back — reusing the same hold-open machinery as the steer fix. Because the turn stays open, its steer handle stays registered too: a message sent while sub-agents work is pushed into the *same* query rather than starting a second one that displaces the first.

- **New `turn-continuation.ts`** — the "may this turn close?" decision as a pure, enumerable policy (following `run-lifetime.ts`): a `Failed` always closes, a pending steer outranks everything, live sub-agents hold the turn open, otherwise it is finished. It also selects the timer, because a steered continuation arrives in milliseconds while a sub-agent runs for minutes; the two cannot share one grace period.
- **`SUBAGENT_LINGER_CAP` (10 minutes)** — a leak guard, not a grace period. A sub-agent whose bookend never arrives still settles the turn with its real `Done`, never the "ended without responding" failure.
- **No change to `runLifetime`** — with the terminal event withheld, `turnSettled` stays false and the existing `turn-in-flight` rule keeps the run alive. Its tests now pin the two rows that depend on, so a later edit cannot quietly reopen this.
- **Stop stays global.** One held-open turn is still one turn, so the Stop button halts the main agent and every sub-agent with it.

Known gap, unchanged: closing the window mid-sub-agent still loses them (`abandoned-mid-turn` outranks everything), now asserted explicitly rather than left to be discovered.
