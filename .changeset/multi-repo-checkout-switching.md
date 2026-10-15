---
"@jingler/cli-adapters": minor
"@jingler/core": minor
"@jingler/contracts": minor
"@jingler/desktop": minor
"@jingler/ui": minor
---

**New: work across several repositories in one session.** The agent can now switch to another repository mid-turn with `switch_checkout`. Jingler attaches an isolated worktree for it, follows its changes, and shows Changes, checks and the PR footer grouped by repository. An unregistered repo asks for your approval first, and approving registers it as a project. Subagents start in the parent's current repository, and a subagent switching repos never moves the parent.
