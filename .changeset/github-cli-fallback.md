---
"@jingler/cli-adapters": patch
"@jingler/contracts": patch
"@jingler/core": patch
"@jingler/desktop": patch
"@jingler/ui": patch
---

Support GitHub without an App installation by routing every non-realtime pull-request and issue operation through an authenticated `gh` CLI, while retaining the App as fallback and for realtime webhooks.

Add a GitHub setting that keeps adversarial review feedback local: low-severity findings are no longer posted to the pull request and every finding is sent to the session agent instead.
