---
"@jingler/desktop": patch
---

Use far fewer GitHub CLI calls. The pull request tab no longer polls every 30 seconds. It loads when you open it or return to the window, and you can refresh it yourself with the new Refresh button. Background PR checks now run every 5 minutes, and auto-review only runs when the PR changes.
