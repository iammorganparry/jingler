---
"@jingler/cli-adapters": patch
---

Add a research-first note to every agent turn. Agents were implementing third-party integration flows (Clerk invitations, billing, webhooks) from trained knowledge, which is stale by definition — the code compiles but ignores the vendor's current recommended flow. The new `<research-first>` turn note requires web-searching the vendor's current official docs before implementing against any external SDK, API, service, or framework surface, matching the docs to the installed package version, and citing the guides followed in the summary. Purely repo-local work is exempt so refactors are not taxed with searches.
