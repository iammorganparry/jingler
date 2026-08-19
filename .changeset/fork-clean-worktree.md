---
"@jingler/desktop": patch
"@jingler/ui": patch
---

Fork a drifted direct session onto a CLEAN worktree. `forkOntoBranch` no longer replays the source checkout's working-tree handoff into the new session — a direct session's shared checkout usually carries the developer's own uncommitted changes, and dragging that dirty tree into the fork made it "look like main". The fork now forks from the drifted branch's committed tip (keeping any commits) and carries only the conversation; the agent re-derives its edits in a clean tree. Also drops the now-impossible `EnvironmentHandoffError` from the `Sessions.forkOntoBranch` error channel.
