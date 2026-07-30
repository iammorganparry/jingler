---
"@jingler/cli-adapters": minor
"@jingler/contracts": minor
"@jingler/core": minor
"@jingler/desktop": minor
"@jingler/ui": minor
---

Keep important sessions in a persistent sidebar tray, with their live agent
status and session actions restored across app restarts.

New sessions can now opt out of an isolated worktree and run directly on the
selected branch in the repository checkout. Jingler guards the shared checkout
against competing direct sessions and branch drift, and deleting a direct
session leaves the repository and its Git registration untouched.
