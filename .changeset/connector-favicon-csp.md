---
"@jingler/ui": patch
"@jingler/desktop": patch
---

Fix provider logos never loading in the app, and the grid rendering as a single column.

Two defects that only appeared in the packaged renderer, both invisible to the test and Storybook loops that signed the feature off.

**Logos.** The favicon URL the Connector Center builds — `https://www.google.com/s2/favicons?domain=…` — answers **301** and redirects to `t{0..3}.gstatic.com`. CSP is enforced against the redirect *target*, so an `img-src` allowing only `www.google.com` blocked every logo. `ConnectorLogo` treats a blocked image as a load error and falls back to an initial-letter tile, so nothing threw and nothing logged: the grid quietly showed letters where 1,100 brand marks should be. `img-src` now allows `https://*.gstatic.com` too, and a test asserts both origins are present — Storybook has no CSP, so a string check on the policy is the only cheap thing that could have caught this.

**Columns.** Settings hands the catalog about 558px. The two-column threshold was derived from a 280px card, putting it at 568 — ten pixels above what the pane actually has, so the grid rendered one card per row in the only place it ships. The card minimum is now 240px (two columns from 488px), and the threshold test pins 558 → 2 explicitly rather than only testing round numbers.
