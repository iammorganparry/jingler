# Hosted Cloudflare memory-state audit

Audit date: `2026-08-06`
Final reconciliation cut-off: `2026-08-06T12:25:28.165Z`

## Executive finding

Hosted source capture is working, but automatic compilation is failing before a
proposal can be persisted. At the final cut-off the organization had **160 source
records**: 158 settled-session digests and two explicit-proposal sources. Their
deterministic compiler handles reconcile exactly to **156 errored, three
published, and one still running**. The three published workflows produced the
only three proposal sets, accepted pages, and accepted revisions. No queued,
pending-review, rejected, or conflicted proposal was observable.

The failure is concentrated in automatic session capture:

| Source path              | Captured | Published | Errored | Running | Publication rate |
| ------------------------ | -------: | --------: | ------: | ------: | ---------------: |
| Settled-session digest   |      158 |         1 |     156 |       1 |            0.63% |
| Explicit-proposal source |        2 |         2 |       0 |       0 |             100% |
| **All sources**          |  **160** |     **3** | **156** |   **1** |        **1.88%** |

Wrangler shows the failed compiler runs consistently pass source validation,
claim extraction, context loading, and deterministic proposal generation. They
then retry `05-lint-and-persist-proposal` six times over about five minutes and
end with `CompilerWorkflowError: vault request failed: memory service failed`.
The most specific explanation is code-backed and locally reproduced: every
settled-session source has the title `Settled Jingler agent session`; unmatched
claims generate a new page with that same title; the first accepted session page
already owns that title; and proposal-set validation rejects the duplicate page
identity. The untyped `MemoryLintError` is then reduced to the generic production 500. This explains why the first session digest published and later session
digests did not.

The graph is correspondingly sparse. Its **163 nodes** are three pages plus 160
sources. All **21 edges are citation occurrences** from pages to just three
source records. There are no page-to-page wikilink, backlink, or dependency
edges, and every accepted page has an empty `relationships` array. The pages are
therefore disconnected as durable knowledge even though citation provenance is
present.

## Scope and evidence method

The inspection was read-only. Organization-scoped `memory_dashboard`,
`memory_graph`, `memory_graph_neighborhood`, `memory_edge_evidence`,
`memory_navigation`, `memory_read`, `memory_reviews`, and
`memory_workflow_status` calls used the existing Jingler desktop login. Wrangler
`4.118.0` was used to inspect the deployed Worker version, bindings, secret
names, R2 bucket metadata, and Workflow resources/instances. No proposal was
approved, rejected, published, deleted, reconciled, restarted, or deployed.

Hosted state continued to receive settled sessions during the audit. Counts are
therefore tied to the exact observations below rather than presented as a frozen
database export:

| Observation                       | Client observation time (UTC)                | Server `asOf` / result                           |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| Dashboard requested with `7d`     | `2026-08-06T12:12:39.782Z`                   | `2026-08-06T12:12:40.193Z`; 158 sources          |
| Dashboard requested with `30d`    | `2026-08-06T12:12:51.211Z`                   | `2026-08-06T12:12:51.366Z`; 158 sources          |
| Initial complete graph            | `2026-08-06T12:13:17.362Z`                   | 161 nodes: 3 pages + 158 sources                 |
| Accepted-page reads               | `2026-08-06T12:16:16.510Z`–`12:16:16.522Z`   | all three accepted pages                         |
| Review inbox                      | `2026-08-06T12:17:01.578Z`                   | three accepted proposal sets                     |
| Deterministic status sweep        | `2026-08-06T12:18:18.944Z`                   | 159 sources: 155 errored, 3 published, 1 running |
| Previously running handle recheck | `2026-08-06T12:24:30.206Z`                   | changed from running to errored                  |
| Final dashboard / graph           | `2026-08-06T12:24:42.794Z` / `12:25:13.983Z` | 160 sources; 163 graph nodes                     |
| Newest source handle              | `2026-08-06T12:25:28.165Z`                   | running                                          |

The final funnel combines the last two rows: the first 159 handles had become
156 errored plus three published, and the one newly arrived source was running.

## Dashboard observations

The requested seven- and 30-day windows returned identical values because all
accepted activity was younger than seven days. The response did not echo the
requested range, so the table records the request alongside the server `asOf`
above.

| Metric family     | Both requested windows at the initial snapshot                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Growth            | 158 sources, 3 accepted pages, 3 revisions; 2 pages/revisions on August 3 and 1 on August 4                  |
| Review            | 3 proposed, 3 accepted, 0 open, 0 conflicted, 0 rejected; acceptance ratio 1; median review time 0 hours     |
| Citations         | 21 citation occurrences, 3 cited pages, coverage ratio 1                                                     |
| Connectivity      | 3 pages, 0 directed page links, 0 connected pages, average degree 0                                          |
| Health/freshness  | 3 orphan pages, 0 broken links, 0 contradictions; all 3 fresh                                                |
| Retrieval         | 192 searches, 17 reads, 7 navigation reads, 1 graph read, 6 proposal calls, 23 results returned              |
| Retrieval quality | 96 unique query hashes, 97 zero-result searches, zero-result ratio 0.8083, median/p95 recorded duration 0 ms |

The final dashboard at server `asOf=2026-08-06T12:24:43.310Z` advanced only
`growth.sources`, from 158 to 160. It still showed three proposal sets, pages,
and revisions, 21 citations, and zero page links.

The dashboard's `retrieval.proposals=6` is tool-call telemetry, not the number of
durable proposal sets. Hosted state contains two distinct
`source:proposal-…` records and three proposal sets total; the third was compiled
from a settled-session digest. The hosted API does not expose a call-to-source
ledger, so the exact split of six calls into idempotent retries or duplicate
content is not independently recoverable here.

## Capture-to-publication funnel

This is the numerically reconciled final cohort at `12:25:28Z`:

| Funnel stage                            |      Count | Reconciliation                                                     |
| --------------------------------------- | ---------: | ------------------------------------------------------------------ |
| Captured sources                        |        160 | 158 `session-digest:*` + 2 `source:proposal-*`                     |
| Deterministic compiler handles resolved |        160 | One handle derived and polled per source; no missing handle        |
| Compiler errored                        |        156 | All are settled-session digests                                    |
| Compiler running                        |          1 | Newly arrived settled-session digest `session-digest:b8bd1497…`    |
| Compiler complete/published             |          3 | 1 settled-session digest + both explicit-proposal sources          |
| Proposal sets                           |          3 | Exactly the three published workflow outputs                       |
| Proposal-set states                     | 3 accepted | 0 open, rejected, conflicted, or superseded in the review response |
| Page proposals                          |          3 | One page per proposal set                                          |
| Accepted pages / revisions              |      3 / 3 | Each page is revision 1                                            |
| Distinct accepted sources cited         |          3 | One underlying source per accepted page                            |
| Citation occurrence edges               |         21 | 3 + 6 + 12 inline references                                       |
| Durable page-to-page edges              |          0 | No wikilinks or dependency relationships                           |

The 160 sources partition completely into 156 errored + 1 running + 3
published. The three published workflows partition completely into three
accepted proposal sets, three page proposals, three accepted revisions, and
three accepted pages. The remaining **157 source nodes have no accepted citation
edge**: 156 are failed compiler inputs and one had not settled at cut-off.

No state was observed for a successful compiler run that produced no proposal.
The deterministic compiler instead either generated at least one draft and
published, or failed before proposal persistence. There is no explicit hosted
`no durable learning` outcome.

## Every accepted page and stable evidence identifiers

All accepted bodies were read, not inferred from search snippets. Excerpts below
are summaries; credential-shaped content is omitted.

### `learning-fnv1a64:4307`

- Path: `learnings/agent-memory-proposal-jingler-pr-qa-gates-fnv1a64:4307.md`
- Title: `Agent memory proposal: jingler-pr-qa-gates`
- Accepted content: three claims about Jingler's CI/release workflows, browser
  QA not being configured, and the local Electron e2e requirement.
- Revision: `revision:proposal:compiler-fnv1a64:a1b15b79fde746d7:page:learning-fnv1a64%3A4307`
- Publication/proposal set: `proposal:compiler-fnv1a64:a1b15b79fde746d7`
- Workflow: `compiler-fnv1a64:a1b15b79fde746d7`
- Source: `source:proposal-fb162bcbb881fbfbc848cc2474878470f75d8a06599227bdfa2d50c424ca2161`
- Citation: `compiler-fnv1a64:4307`
- Accepted/created: `2026-08-03T13:32:58.213Z`
- Author: `agent:session-capture`; revision number 1; three inline citation
  occurrences; zero relationships and zero backlinks.

### `learning-fnv1a64:9b3e`

- Path: `learnings/agent-memory-proposal-learnings-jarvis-persisted-fnv1a64:9b3e.md`
- Title: `Agent memory proposal: learnings/jarvis-persisted-recommendation-data-part-reload-crash`
- Accepted content: six claims tracing a deterministic Jarvis reload crash to a
  persisted flattened data-part shape read as nested `part.data` by the renderer.
- Revision: `revision:proposal:compiler-fnv1a64:959f005224c9d05e:page:learning-fnv1a64%3A9b3e`
- Publication/proposal set: `proposal:compiler-fnv1a64:959f005224c9d05e`
- Workflow: `compiler-fnv1a64:959f005224c9d05e`
- Source: `source:proposal-cc5eb01f23094ebd916a071cea540d3f0152c8f9846e98bdb4c76c3e00ee747c`
- Citation: `compiler-fnv1a64:9b3e`
- Accepted/created: `2026-08-04T16:12:07.385Z`
- Author: `agent:session-capture`; revision number 1; six inline citation
  occurrences; zero relationships and zero backlinks.

### `learning-fnv1a64:d32f`

- Path: `learnings/settled-jingler-agent-session-fnv1a64:d32f.md`
- Title: `Settled Jingler agent session`
- Accepted content: 12 transcript-derived lines about diagnosing a missing
  memory connector. It includes empty `User request` / `Settled outcome` claims
  and progress narration, so it is evidence that automatic capture can publish,
  but not evidence of high-quality durable compilation.
- Revision: `revision:proposal:compiler-fnv1a64:fc32699ca0ff9d37:page:learning-fnv1a64%3Ad32f`
- Publication/proposal set: `proposal:compiler-fnv1a64:fc32699ca0ff9d37`
- Workflow: `compiler-fnv1a64:fc32699ca0ff9d37`
- Source: `session-digest:967b3064a0631045cda71bd6c5b0e532506c658ce6bbeaef07a474885213a766`
- Citation: `compiler-fnv1a64:d32f`
- Accepted/created: `2026-08-03T09:37:58.309Z`
- Author: `agent:session-capture`; revision number 1; 12 inline citation
  occurrences; zero relationships and zero backlinks.

Each `memory_read` returned one declared citation ID and one source ID. The graph
contains multiple edges because it creates an edge for every inline citation
reference, not for every distinct citation declaration. Representative
`memory_edge_evidence` reads resolved the exact page path, source ID, citation
ID, line, and column for one edge from each page.

## Compiler failure diagnosis

### Direct production observations

- Every source had a deterministic public compiler handle; no workflow was
  missing from `memory_workflow_status`.
- The three accepted handles return `state=complete` and
  `result.status=published`.
- A representative failed session source,
  `session-digest:401d03b7228d65765618c0a4adb34d413a81f0f1d3908140217cc924e0d2d794`,
  maps to `compiler-fnv1a64:a6afd24f78eccc00` and errored after about five
  minutes.
- Wrangler's instance description shows steps 01–04 succeed immediately. Step
  05 fails at 0, 10, 30, 70, 150, and 310 seconds with the same generic vault
  error. It never reaches auto-publication.
- The source and compiler context are readable from the Durable Object before
  the failing write, so this is not source loss, authentication, R2-read failure,
  model failure, or graph indexing failure.

### Code-backed root cause

The deployed code version includes the same relevant path inspected locally:

1. Session capture stores every digest with title `Settled Jingler agent
session`.
2. `DeterministicCompilerModel.newPageDraft` copies `context.source.title` into
   the generated page title whenever at least one claim has no matching existing
   page.
3. The first accepted session page, `learning-fnv1a64:d32f`, already owns that
   title.
4. `prepareProposalSet` validates the candidate repository with
   `assertMemoryValid`; memory identities include titles, so another page with
   that title produces duplicate-identity errors.
5. `MemoryLintError` is not a `MemoryVaultError`, so the Worker error boundary
   returns only `{code: internal_error, error: memory service failed}`. The
   Workflow retries a permanent validation failure and eventually reports
   `errored` without the lint details.

A local, non-mutating reproduction passed an existing generic-title page and a
new compiler-shaped page with the same title through `prepareProposalSet`. It
returned `MemoryLintError: memory validation failed with 2 issues:
duplicate-identity, duplicate-identity`, matching the production failure
boundary. Production logs expose only the generic 500, so the duplicate-title
exception is a code-and-reproduction-backed attribution rather than a verbatim
production exception message.

The outcome distribution independently supports it: the first session digest
published; both differently titled explicit-proposal sources published; every
settled-session digest in the final errored set failed; and the previously
running session digest was observed retrying step 05 before it joined that
errored set. The newest source had only reached the generic `running` state at
cut-off, so its eventual outcome is not claimed.

## Graph, citations, and why the pages are disconnected

The final untruncated graph manifest has:

| Node/edge kind                 | Count |
| ------------------------------ | ----: |
| Accepted page nodes            |     3 |
| Session-digest source nodes    |   158 |
| Explicit-proposal source nodes |     2 |
| Citation edges                 |    21 |
| Wikilink edges                 |     0 |
| Backlink edges                 |     0 |
| Dependency edges               |     0 |
| Schema relationship edges      |     0 |

All pages are grouped under `topic:compiled-learning`, but a topic cluster is a
categorization, not a durable relationship. The only one-hop neighbor of each
page is its source record:

| Page                    | Inline citation edges | Distinct cited source | Page relationships/backlinks |
| ----------------------- | --------------------: | --------------------: | ---------------------------: |
| `learning-fnv1a64:4307` |                     3 |                     1 |                        0 / 0 |
| `learning-fnv1a64:9b3e` |                     6 |                     1 |                        0 / 0 |
| `learning-fnv1a64:d32f` |                    12 |                     1 |                        0 / 0 |

The full graph endpoint receives repository sources, so its page-node degrees
are 3, 6, and 12 and its per-node `health.orphan` values are false. Dashboard
connectivity calls the graph builder with accepted pages but without repository
sources. Because all three pages keep citations in the repository rather than
embedding source definitions, their citation targets are unavailable in that
projection; it reports `connectedPages=0` and `orphanPages=3`. `directedLinks`
also intentionally counts only forward page-to-page wikilinks and dependencies.

Thus the two views are explainable but use different orphan semantics. In the
sense relevant to a knowledge graph, all three pages are disconnected because
they contain no page references or relationships. Citation provenance does not
connect one durable learning to another.

There is no evidence of a failed graph index:

- the complete graph is untruncated and contains all pages and sources;
- deterministic navigation lists all three accepted pages and all three
  acceptance timestamps;
- every citation edge tested resolves to accepted evidence;
- accepted-page reads and lexical retrieval work;
- vector-ingest workflows show no current errors.

Graph sparsity is instead the combined result of only three published pages,
compiler output that does not synthesize relationships, and the dashboard/full-
graph projection distinction above.

## Production configuration and persistence health

| Area              | Read-only production evidence                                                                                                       | Finding                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Worker deployment | Current production is 100% on the August 3 secret-change deployment backed by the August 3 code upload.                             | No split traffic or stale second version was visible.                                                                        |
| Durable Object    | Active version binds `MEMORY_VAULTS` to SQLite `TeamVaultObject`; page, source, FTS/navigation, dashboard, and graph reads succeed. | DO is reachable. Failure is localized to proposal validation/persistence.                                                    |
| R2                | `jingler-memory`, WEUR, Standard, 398 objects, approximately 982 kB. Source and accepted-revision reads succeed.                    | The recovery store is populated; no evidence of missing accepted blobs.                                                      |
| Compiler Workflow | Resource exists; all 160 public handles resolve. Wrangler and MCP agree on published/errored/running states.                        | Durable invocation works; 156 permanent step-05 failures are the primary loss.                                               |
| Lint Workflow     | Resource exists but Wrangler reports **zero instances**. Active bindings contain no `MEMORY_LINT_ORGANIZATIONS`.                    | Scheduled vault lint is effectively disabled for every organization.                                                         |
| Vector ingest     | 15 instances: 12 completed and 3 early terminated instances; no errored current instance. Daily sweeps ran on August 4–6.           | No evidence that advisory vector indexing caused graph sparsity.                                                             |
| Queue             | No Cloudflare Queue producer, consumer, or binding exists in the deploy contract. Source ingest starts Workflows directly.          | There is no queue backlog or DLQ to inspect; Workflow is the durable transport.                                              |
| Secrets/config    | Service, OpenAI, and turbopuffer secret names exist. The documented stable `MEMORY_WORKFLOW_ID_SECRET` is absent.                   | Current handles resolve, but a future service-secret rotation can change scoped Workflow instance IDs and weaken continuity. |
| Review gate       | `MEMORY_REQUIRE_REVIEW` is absent and accepted timestamps equal proposal timestamps.                                                | Default auto-publish explains zero-hour review latency; human review is not blocking publication.                            |

A 30-second Worker tail filtered to new errors produced no event; it is not a
historical log query and does not outweigh the detailed Workflow instance error
history. Wrangler also rejected a requested 200-row instance page with API code
10002, so exact workflow counts come from the organization-scoped deterministic
status sweep, while Wrangler supplies representative retry/error detail.

## Unexplained or non-joinable deltas

- **Live source growth:** state advanced from 158 sources at the two dashboard
  observations to 160 at the final graph. Both arrivals were individually
  identified as session digests; one had errored and the newest was running by
  the final cut-off. No source is missing from the stated 160-source funnel.
- **Six proposal calls versus two manual-proposal sources:** the dashboard stores
  aggregate proposal-call telemetry, while the hosted graph exposes unique
  source records. There is no hosted call-to-idempotency ledger, so four call
  events cannot be assigned to retries or duplicates from this API alone.
- **Generic compiler errors:** hosted status and Wrangler retain state and retry
  timing but sanitize the underlying `MemoryLintError`. The duplicate-title
  cause is supported by deployed code, the generated source/page titles, the
  source-type outcome split, and a local reproduction, but not by an unsanitized
  production exception string.
- **R2 object count:** R2 contains immutable source, history, revision, and
  publication artifacts, so 398 objects are not expected to equal the 160
  logical source count. Wrangler exposes bucket totals but no safe object-list
  command; no object-by-object reconciliation was attempted.

## Conclusions

The hosted system is not failing to receive settled sessions. It is receiving
them and starting deterministic compiler workflows, then losing almost all
automatic memory creation at a repeatable proposal-validation boundary. This is
the dominant server-side explanation for three pages after many sessions.

The current three pages also cannot form a knowledge graph: none declares a
page relationship or wikilink. Citation edges prove provenance but do not encode
durable relationships. The graph's disconnected state is therefore explained by
low accepted-page volume plus relationship-free compiler output, with an
additional dashboard/full-graph orphan-semantics mismatch—not by missing graph
projection or vector indexing.

Follow-up work is outside this read-only stage, but the evidence points directly
to four priorities: make session-derived page identity unique or select an
explicit update/no-op outcome; surface typed compiler validation failures;
enable scheduled lint for the organization; and generate or review meaningful
page-to-page relationships rather than treating citation volume as graph
connectivity.
