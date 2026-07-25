---
"@starbase/core": patch
---

Offer a pinned `claude-opus-5` alongside the `opus` alias

The Claude fallback catalogue listed Opus 5 only as the moving `opus` alias.
That is the right default — a session should follow Claude Code's current Opus
release — but it left no way to hold a session on *this* release the way
`claude-opus-4-8` and the `[1m]` variants already allow.

Worth pinning because the alias and the picker drift apart: Claude Code's
`/model` shortlist is baked into the CLI build, so Opus 5 was reachable via
`--model claude-opus-5` while the shortlist still showed 4.8. An explicit id
is the escape hatch for exactly that gap, and it is the same id the harness
accepts today.

No `[1m]` variant, unlike 4.8/4.7/4.6: Opus 5's 1M window is both the default
and the maximum, so there is no wider mode to opt into. `contextWindowFor`
already reads `opus-5` as 1M — the entry is now covered by a test so a future
prefix edit can't quietly drop it back to the 200k default, which is the one
mis-read this table cannot recover from.
