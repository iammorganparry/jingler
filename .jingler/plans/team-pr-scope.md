# Team PR view — agreed scope

- [x] Trace the existing PR view, fetching, auth, and pickup actions.
- [x] Check current GitHub docs for team discovery and PR queries.
- [x] Agree what team PRs includes and which GitHub hosts to support.
- [x] Record the MVP, exclusions, implementation steps, and acceptance checks.

Scoping complete. No product code changed; implementation has not been authorized.

## Operator decisions

- Support GitHub.com / Enterprise Cloud, not self-hosted Enterprise Server.
- Provide three separate team filters: requested reviews, member-authored PRs, and team-repository PRs.
- Member-authored PRs are restricted to the selected team's organization.
- Picking up work uses existing local actions; no new GitHub assignment or reviewer-claim action.
- Team support must use the authenticated GitHub CLI. The GitHub App is not an option.

## Proposed first version

Extend the existing global Pull requests inbox, not the session-specific PR tab. Keep the existing personal view and add a team selector grouped by organization. Discover the active CLI account's memberships; select one team at a time. Default its queue to Requested reviews. Remember the selected team/filter per account locally, and discard a stale selection when membership changes.

| Team filter | Includes | Fetch strategy |
| --- | --- | --- |
| Requested reviews | Open PRs explicitly requesting the selected team | Search `is:pr is:open team-review-requested:ORG/SLUG` |
| Member-authored | Open PRs authored by current team members within that organization | Paginate team members, then organization-scoped author searches |
| Team repositories | Open PRs in the team's repositories visible to the CLI account | Paginate team repositories, then list their open PRs |

Include drafts with the existing Draft badge. Include child-team members as returned by GitHub's member API. Sort newest-updated first, deduplicate by repository + PR number, and reuse existing text search. Membership-based queues reflect current membership, not membership at the time a PR was opened. Team review requests follow GitHub's pending-request semantics, not historical reviews or all possible CODEOWNERS matches.

Provide Refresh and refresh on returning to the view. Do not add background polling or webhooks. Show loading, genuinely empty, authentication/access failure, and partial-results states distinctly. Cache team members/repositories per account and selected team; refresh must allow discovery changes to be picked up.

Reuse PR detail, Open on GitHub, Open files, and Open/Create session. A local session still requires the existing registered/available project; otherwise explain that requirement. No automatic clone/import flow. Opening files/session must not assign the PR or alter its reviewers.

Team discovery, queue fetching, and selected-team PR reads/actions must use the same CLI account without GitHub App fallback. Preserve existing personal inbox behavior; removing GitHub App support elsewhere is outside this scope.

## Existing code to extend

| Area | Existing code |
| --- | --- |
| Inbox UI | `packages/ui/src/composites/pull-request-inbox.tsx` |
| Renderer query and selection | `apps/desktop/src/renderer/use-pull-request-inbox.ts`; `App.tsx` local session wiring |
| Typed data / RPC | `packages/core/src/domain.ts`; `packages/contracts/src/index.ts`; `apps/desktop/src/main/rpc.ts` |
| CLI/API fetch | `packages/cli-adapters/src/github-cli.ts`; `github-api.ts`; shared mappers |
| Coverage | Existing inbox UI/hook and GitHub CLI/API tests; `apps/desktop/e2e/github-cli-pr.spec.ts` |

The current CLI inbox query is `is:pr is:open involves:@me`; it cannot discover team work by client-side filtering. The current API facade prefers CLI reads but may fall back to App credentials, and installed-repository writes prefer App credentials. Team mode therefore needs an explicit CLI-only path, including detail/actions, while reusing existing mapping and session logic.

The integration uses existing `gh` execution and REST/GraphQL, not a new SDK. Repository Octokit dependencies are app `^16.1.4`, request `^10.0.13`, and webhooks `^14.2.0`; none is needed for the team flow. Confirm the local CLI version/capabilities during implementation; no authenticated CLI calls were run during scoping.

## Access and scale constraints

Use paginated `GET /user/teams`, `GET /orgs/{org}/teams/{slug}/members`, and `GET /orgs/{org}/teams/{slug}/repos` through the existing command executor, explicitly targeting github.com. Validate organization/team inputs and return typed data through RPC. Keep credentials in the CLI/main process; never return tokens to the renderer.

CLI credentials need applicable organization/repository permissions and organization SSO authorization where required. Fine-grained tokens may only reveal teams in their owning organization. Do not interpret missing access as proof that a team has no PRs, and do not silently substitute an App identity.

Paginate discovery and PRs. Bound concurrent requests and respect rate-limit/backoff signals. Search endpoints have result limits; split searches by repository/author/time as necessary rather than assuming `--paginate` or `--limit 1000` means all results. Report incomplete/failed portions explicitly with retry; do not label partial data as a complete queue. Establish this retrieval approach in the first implementation step, before UI work.

First version covers organization teams in Enterprise Cloud. Enterprise-level team identities spanning multiple organizations are not included by these organization-team queries.

## Implementation plan and estimate

Estimate: **960 minutes (16 engineering hours)** including tests and local verification, assuming working CLI access to a representative organization. Validate large-team/search behavior first; that is the main estimate risk.

1. Verify live CLI discovery/query behavior and result-limit handling; add typed team/queue models and CLI-only RPC contracts — 180 minutes.
2. Implement discovery and three queue fetches, account isolation, pagination, deduplication, access errors, and bounded concurrency — 300 minutes.
3. Extend the existing inbox controls/query state with an XState machine where coordinated selection/persistence requires it; reuse detail/session actions with CLI-only team routing — 180 minutes.
4. Add behavior coverage and built-Electron e2e for all filters, switch/refresh behavior, access errors, and local pickup; add a changeset — 180 minutes.
5. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm --filter @jingler/desktop e2e`; perform relevant security checks and fix findings — 120 minutes.

## Acceptance checks

- The team selector shows memberships for the active CLI account; changing accounts cannot reuse another account's selection, cached data, or permissions.
- Each filter returns the correct PRs, including drafts, child-team member authors, and accessible team repositories; unrelated authors/repositories/review requests are excluded appropriately.
- Multiple discovery/result pages, duplicate PRs, search limits, rate limits, and partial failures are exercised; incomplete data is visibly marked and refresh/retry works.
- No CLI, expired credentials, insufficient scope, or SSO denial produces actionable errors. No team operation falls back to the GitHub App.
- Opening detail/files/session works through existing actions, including an existing session and missing local project. No new claim/assignment mutation occurs. Built-Electron e2e and required repo checks pass before shipping.

## Exclusions

Self-hosted Enterprise Server, multi-team combined queues, enterprise-level cross-organization teams, GitHub App team access, new inline review submission, new assignment/claim actions, automatic repository cloning, webhook/live synchronization, and historical membership reporting.

## Official guides used for scoping

- Teams discovery and repository listing: https://docs.github.com/en/rest/teams/teams
- Team members (including child-team membership): https://docs.github.com/en/rest/teams/members
- PR search qualifiers and pending-review semantics: https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
- Search result limits, incomplete results, and access behavior: https://docs.github.com/en/rest/search/search
- CLI credential scope refresh: https://cli.github.com/manual/gh_auth_refresh

Current official documentation was read during scoping. Implementation must recheck the chosen REST API version/CLI capabilities. No product tests were run because this task only produced the scope document.
