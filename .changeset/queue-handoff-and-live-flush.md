---
"@jingler/desktop": minor
"@jingler/cli-adapters": minor
"@jingler/core": minor
"@jingler/ui": minor
---

Queued messages now behave like Claude Code's: the head of the queue is handed to
the LIVE turn at the next tool boundary instead of waiting for the whole turn to
settle, so a correction typed 10 seconds in reaches the agent while it is still
relevant. Claude gains native steering for this (the adapter holds the SDK's
streaming input open for the life of the turn); harnesses with no channel into a
running turn are untouched rather than interrupted.

Each queued row also gains icon actions: send now, hand off, edit, remove.
Hand-off forks the message into a fresh chat on the default model from
Settings › Providers — for the follow-up that turns out to be its own job.
