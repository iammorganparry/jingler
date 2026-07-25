---
"@starbase/ui": patch
"@starbase/core": patch
"@starbase/cli-adapters": patch
"@starbase/contracts": patch
---

Rebuild Settings › Connectors as a logo grid with a per-provider detail sheet, and fix the three catalog-mapping bugs the redesign exposed.

The catalog was a flat 52px list of ~1,100 rows with a first-initial tile where a logo should be. It is now a virtualized grid of cards — brand logo, auth-mode chips, category, and a status dot — with All / Connected / Not connected tabs whose counts re-scope to the active search and category filter, so a tab never promises a result it cannot show.

Logos come from each provider's `homepageUrl` hostname through Google's favicon service, the same source OOMOL Connect's own Providers page uses. That indirection is not a shortcut: OpenConnector's catalog returns `iconUrl: null` for every one of its providers, and a homepage for every one. Providers with no parseable homepage, and any favicon that fails to load, fall back to the initial tile. This widens the renderer's CSP `img-src` to allow `https://www.google.com` — images only.

Clicking a card now opens a detail sheet carrying the provider's real connect form, fetched one provider at a time from `GET /api/providers/{service}` behind a new `Connector.provider` RPC. Per-provider on purpose: the endpoint that returns every provider's fields at once inlines each action's JSON Schema and weighs ~5 MB. Before this, the catalog list response carried no auth fields at all, so *every* provider fell through to a single generic "API key" box — Linear's `lin_api_…` placeholder, Notion's "Internal Integration Secret" label and every custom-credential provider's multi-field form were all unreachable. Providers offering both OAuth and a key now get a segmented control rather than one form stacked above the other, and the sheet lists the OAuth scopes the grant will request.

Three data bugs went with it, each pinned by a test using a payload captured from a live instance:

- `no_auth` was missing from the auth-type union. Since an unrecognised type is indistinguishable from an unknown one, the mapper defaulted those providers to `api_key` and put a credential form in front of the handful (arXiv, Hacker News, Docsend2pdf) that take no credential and arrive already usable. They now read "No auth needed — ready to use".
- Connections were read at the wrong nesting level. The instance nests the account under `profile`; the mapper looked for `accountId`/`displayName`/`grantedScopes` at the root, so every connected row rendered a blank account and zero scopes — a silent empty, not an error.
- A connection alias of `default` was sent explicitly, which creates a *second* connection rather than addressing the default one. The alias is now omitted unless the operator names it.
