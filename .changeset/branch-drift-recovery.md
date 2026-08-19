---
"@jingler/desktop": patch
"@jingler/ui": patch
---

Make a drifted direct session recoverable instead of a dead end. When a direct session's shared checkout moves off the branch it is pinned to (typically the agent running `git switch -c`), the turn now stops on a recovery banner in the transcript rather than repeating a "switch the repository back" error. From the banner the operator can **Fork new session** — hand the work off to a fresh isolated worktree session forked from the live branch, carrying the transcript and uncommitted changes, leaving the original pinned to its branch — or **Adopt** the live branch into the current session. Backed by two new RPCs (`Sessions.adoptBranch`, `Sessions.forkOntoBranch`) and a typed `BranchDrift` conversation event.
