---
"@jingler/desktop": patch
---

Fixed the PR's Files view showing no changes in a multi-repo session after the agent switched to a repo without a PR. Changes now reads the PR from the checkout that owns it.
