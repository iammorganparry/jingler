---
"@jingler/ui": patch
"@jingler/contracts": minor
"@jingler/cli-adapters": minor
---

A review belongs to one chat, and the sub-agent view drops its duplicate header.

**The leak.** Open a session that has run an adversarial review, start a new chat, and the new chat immediately showed a `Reviewer — Adversarial review` pill in its sub-agent rail, replaying a run it had nothing to do with. `Review.watch` is session-scoped and replays its buffer (and the stored transcript) to every late subscriber, but each *chat* runs its own conversation machine and every one of them subscribed. A session-level artifact rendered inside a chat's rail has to belong to exactly one chat, or every chat you create inherits it.

A review is now owned by the chat that was the session's `activeChatId` at the instant the run **started** — stamped in the same place the buffer and transcript are reset for a new run, so ownership is fixed at birth and a later chat switch doesn't move it. `Review.watch` takes the subscriber's `chatId` and emits only to the owner. The owner is persisted with the transcript, so a restart brings the tab back in the right chat rather than in all of them; a transcript written before this change has no owner and stays visible everywhere, which is the old behaviour kept deliberately so an existing review doesn't vanish — it self-heals on the next run.

**The duplicate header.** `SubagentView` drew a ruled row naming the agent, its task and a `WATCH-ONLY` lozenge — every word of which the selected pill in the rail immediately above already says, and the rule was a third horizontal line in a pane that had just been cut down to one. A label sitting directly beneath the identical label it repeats reads as two different things until you look twice. It's gone.
