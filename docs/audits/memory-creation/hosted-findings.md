# Hosted Cloudflare memory-state audit

Audit date: `2026-08-06`
Final reconciliation cut-off: `2026-08-06T13:15:06.048Z`

## Executive finding

Hosted source capture is working, but automatic compilation is failing before a
proposal can be persisted. At the final cut-off the organization had **168 source
records**: 162 settled-session digests and six explicit-proposal sources. Their
deterministic compiler handles reconcile exactly to **160 errored, seven
published, and one still running**. The seven published workflows produced the
only seven proposal sets, accepted pages, and accepted revisions. No queued,
pending-review, rejected, or conflicted proposal was observable.

The failure is concentrated in automatic session capture:

| Source path              | Captured | Published | Errored | Running | Publication rate |
| ------------------------ | -------: | --------: | ------: | ------: | ---------------: |
| Settled-session digest   |      162 |         1 |     160 |       1 |            0.62% |
| Explicit-proposal source |        6 |         6 |       0 |       0 |             100% |
| **All sources**          |  **168** |     **7** | **160** |   **1** |        **4.17%** |

Wrangler shows a representative failed compiler run pass source validation,
claim extraction, context loading, and deterministic proposal generation. It
then retries `05-lint-and-persist-proposal` six times over about five minutes
and ends with
`CompilerWorkflowError: vault request failed: memory service failed`.
The most specific explanation is code-backed and locally reproduced: every
settled-session source has the title `Settled Jingler agent session`; unmatched
claims generate a new page with that same title; the first accepted session page
already owns that title; and proposal-set validation rejects the duplicate page
identity. The untyped `MemoryLintError` is then reduced to the generic production
500. This explains why the first session digest published and later session
digests did not.

The graph is correspondingly sparse. Its **175 nodes** are seven pages plus 168
sources. All **42 edges are citation occurrences** from pages to just seven
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

| Observation                    | Client observation time (UTC)                       | Server `asOf` / result                            |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------- |
| Dashboard requested with `7d`  | `2026-08-06T13:14:12.848Z`–`13:14:13.051Z`          | `2026-08-06T13:14:13.097Z`; 168 sources           |
| Dashboard requested with `30d` | `2026-08-06T13:14:13.051Z`–`13:14:13.209Z`          | `2026-08-06T13:14:13.249Z`; 168 sources           |
| Complete graph                 | `2026-08-06T13:14:20.517Z`–`13:14:20.721Z`          | 175 nodes: 7 pages + 168 sources; untruncated     |
| Accepted-page reads            | `2026-08-06T13:14:30.323Z`–`13:14:31.874Z`          | all seven accepted pages                          |
| Status and review sweep        | `2026-08-06T13:15:00.738Z`–`13:15:06.048Z`          | 168 sources: 160 errored, 7 published, 1 running |
| Wrangler diagnostics           | `2026-08-06T13:16Z`–`13:17Z`                        | active deployment, bindings, R2, Workflow detail |
| Citation-edge evidence         | `2026-08-06T13:20:49.864Z`–`13:20:50.238Z`          | one resolved evidence edge for every page         |

The graph, status, and review sweep share the same 168-source set. The one
nonterminal source is identified explicitly in the funnel below.

## Dashboard observations

The requested seven- and 30-day windows returned identical values because all
accepted activity was younger than seven days. The response did not echo the
requested range, so the table records the request alongside the server `asOf`
above.

| Metric family     | Both requested windows at the snapshot                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Growth            | 168 sources, 7 accepted pages, 7 revisions; 2 on August 3, 1 on August 4, and 4 on August 6                    |
| Review            | 7 proposed, 7 accepted, 0 open, 0 conflicted, 0 rejected; acceptance ratio 1; median review time 0 hours       |
| Citations         | 42 citation occurrences, 7 cited pages, coverage ratio 1                                                       |
| Connectivity      | 7 pages, 0 directed page links, 0 connected pages, average degree 0                                            |
| Health/freshness  | 7 orphan pages, 0 broken links, 0 contradictions; all 7 fresh                                                  |
| Retrieval         | 216 searches, 17 reads, 7 navigation reads, 1 graph read, 6 proposal calls, 23 results returned                |
| Retrieval quality | 109 unique query hashes, 114 zero-result searches, zero-result ratio 0.8321, median/p95 recorded duration 0 ms |

The dashboard's `retrieval.proposals=6` is tool-call telemetry, not the number of
durable proposal sets. Hosted state now also contains six distinct
`source:proposal-…` records, but that numerical equality is not a join: the metric
was already six when only two manual sources existed, and it did not visibly
advance after four new audit proposals published. The hosted API exposes no
call-to-source ledger, so the telemetry delta remains non-joinable.

## Capture-to-publication funnel

This is the numerically reconciled final cohort at `13:15:06Z`:

| Funnel stage                            |      Count | Reconciliation                                                     |
| --------------------------------------- | ---------: | ------------------------------------------------------------------ |
| Captured sources                        |        168 | 162 `session-digest:*` + 6 `source:proposal-*`                     |
| Deterministic compiler handles resolved |        168 | One handle derived and polled per source; no missing handle        |
| Compiler errored                        |        160 | All are settled-session digests                                    |
| Compiler running                        |          1 | Session digest `session-digest:e6de2d90…`                          |
| Compiler complete/published             |          7 | 1 settled-session digest + all 6 explicit-proposal sources         |
| Proposal sets                           |          7 | Exactly the seven published workflow outputs                       |
| Proposal-set states                     | 7 accepted | 0 open, rejected, conflicted, or superseded in the review response |
| Page proposals                          |          7 | One page per proposal set                                          |
| Accepted pages / revisions              |      7 / 7 | Each page is revision 1                                            |
| Distinct accepted sources cited         |          7 | One underlying source per accepted page                            |
| Citation occurrence edges               |         42 | 5 + 6 + 3 + 6 + 5 + 5 + 12 inline references                      |
| Durable page-to-page edges              |          0 | No wikilinks or dependency relationships                           |

The 168 sources partition completely into 160 errored + 1 running + 7
published. The seven published workflows partition completely into seven
accepted proposal sets, seven page proposals, seven accepted revisions, and
seven accepted pages. The remaining **161 source nodes have no accepted citation
edge**: 160 are failed compiler inputs and one had not settled at cut-off.

No state was observed for a successful compiler run that produced no proposal.
The deterministic compiler instead either generated at least one draft and
published, or failed before proposal persistence. There is no explicit hosted
`no durable learning` outcome.

## Every accepted page and stable evidence identifiers

All accepted bodies were read, not inferred from search snippets. Excerpts below
are summaries; credential-shaped content is omitted.

### `learning-fnv1a64:0784`

- Path: `learnings/agent-memory-proposal-jingler-memory-audit-natur-fnv1a64:0784.md`
- Title: `Agent memory proposal: jingler-memory-audit-natural-creation-trigger-2026-08-06`
- Accepted content: five claims summarizing the transcript audit's zero natural
  proposals and the need for bounded end-of-turn reflection.
- Revision: `revision:proposal:compiler-fnv1a64:28b8e4187955ecbc:page:learning-fnv1a64%3A0784`
- Publication/proposal set: `proposal:compiler-fnv1a64:28b8e4187955ecbc`
- Workflow: `compiler-fnv1a64:28b8e4187955ecbc`
- Source: `source:proposal-f1eb1509d4db634cfe0e9604423adaca92c8e0d127bec91e44fba2e8f37cb2c1`
- Citation: `compiler-fnv1a64:0784`
- Accepted/created: `2026-08-06T12:58:02.413Z`
- Author: `agent:session-capture`; revision number 1; five inline citation
  occurrences; zero relationships and zero backlinks.

### `learning-fnv1a64:3963`

- Path: `learnings/agent-memory-proposal-jingler-memory-audit-compi-fnv1a64:3963.md`
- Title: `Agent memory proposal: jingler-memory-audit-compiler-policy-gaps-2026-08-06`
- Accepted content: six claims about line-shape extraction, the absent no-op, the
  unused compiler prompt, and relationship-free deterministic output.
- Revision: `revision:proposal:compiler-fnv1a64:e22781acd8f4ad4b:page:learning-fnv1a64%3A3963`
- Publication/proposal set: `proposal:compiler-fnv1a64:e22781acd8f4ad4b`
- Workflow: `compiler-fnv1a64:e22781acd8f4ad4b`
- Source: `source:proposal-46bc923231e3a6e787cf70d76b579595534f6fdb29907efb1cbcb52841219d62`
- Citation: `compiler-fnv1a64:3963`
- Accepted/created: `2026-08-06T12:58:07.511Z`
- Author: `agent:session-capture`; revision number 1; six inline citation
  occurrences; zero relationships and zero backlinks.

### `learning-fnv1a64:a8df`

- Path: `learnings/agent-memory-proposal-jingler-memory-audit-citat-fnv1a64:a8df.md`
- Title: `Agent memory proposal: jingler-memory-audit-citation-vs-page-links-2026-08-06`
- Accepted content: five claims distinguishing citation provenance from durable
  page relationships and explaining the dashboard/full-graph orphan semantics.
- Revision: `revision:proposal:compiler-fnv1a64:907b62f499e2e2e7:page:learning-fnv1a64%3Aa8df`
- Publication/proposal set: `proposal:compiler-fnv1a64:907b62f499e2e2e7`
- Workflow: `compiler-fnv1a64:907b62f499e2e2e7`
- Source: `source:proposal-ee656262ceb16e2dde2f780fd60936e10c50f1b7d180edb22a34cb567de788af`
- Citation: `compiler-fnv1a64:a8df`
- Accepted/created: `2026-08-06T12:58:10.983Z`
- Author: `agent:session-capture`; revision number 1; five inline citation
  occurrences; zero relationships and zero backlinks.

### `learning-fnv1a64:acba`

- Path: `learnings/agent-memory-proposal-jingler-memory-audit-sessi-fnv1a64:acba.md`
- Title: `Agent memory proposal: jingler-memory-audit-session-title-collision-2026-08-06`
- Accepted content: five claims recording the generic session-title collision,
  the original frozen workflow funnel, and the need for typed terminal errors.
- Revision: `revision:proposal:compiler-fnv1a64:90254587584303bd:page:learning-fnv1a64%3Aacba`
- Publication/proposal set: `proposal:compiler-fnv1a64:90254587584303bd`
- Workflow: `compiler-fnv1a64:90254587584303bd`
- Source: `source:proposal-ddae5d76ace5bc62ec4532c2fc57e4c2c10f18884e9c0610541be0888057b0cc`
- Citation: `compiler-fnv1a64:acba`
- Accepted/created: `2026-08-06T12:58:05.227Z`
- Author: `agent:session-capture`; revision number 1; five inline citation
  occurrences; zero relationships and zero backlinks.

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
- The seven accepted handles return `state=complete` and
  `result.status=published`.
- A representative failed session source,
  `session-digest:228c9541306641ef4c5741a9058df279da37e17ea7dc4323aadde8982efb0491`,
  maps to `compiler-fnv1a64:ea66070d8eb93782` and errored after about five
  minutes. Wrangler exposes that invocation as
  `team-P4mQNGEUfrL0FD0n9C7P2SJzkc34S4KLj5ByryD_vS8`.
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
published; all six differently titled explicit-proposal sources published; and
every settled-session digest in the final errored set failed. The newest source
had only reached the generic `running` state at cut-off, so its eventual outcome
is not claimed.

## Graph, citations, and why the pages are disconnected

The final untruncated graph manifest has:

| Node/edge kind                 | Count |
| ------------------------------ | ----: |
| Accepted page nodes            |     7 |
| Session-digest source nodes    |   162 |
| Explicit-proposal source nodes |     6 |
| Citation edges                 |    42 |
| Wikilink edges                 |     0 |
| Backlink edges                 |     0 |
| Dependency edges               |     0 |
| Schema relationship edges      |     0 |

All pages are grouped under `topic:compiled-learning`, but a topic cluster is a
categorization, not a durable relationship. The only one-hop neighbor of each
page is its source record:

| Page                    | Inline citation edges | Distinct cited source | Page relationships/backlinks |
| ----------------------- | --------------------: | --------------------: | ---------------------------: |
| `learning-fnv1a64:0784` |                     5 |                     1 |                        0 / 0 |
| `learning-fnv1a64:3963` |                     6 |                     1 |                        0 / 0 |
| `learning-fnv1a64:4307` |                     3 |                     1 |                        0 / 0 |
| `learning-fnv1a64:9b3e` |                     6 |                     1 |                        0 / 0 |
| `learning-fnv1a64:a8df` |                     5 |                     1 |                        0 / 0 |
| `learning-fnv1a64:acba` |                     5 |                     1 |                        0 / 0 |
| `learning-fnv1a64:d32f` |                    12 |                     1 |                        0 / 0 |

The full graph endpoint receives repository sources, so its page-node degrees
are 5, 6, 3, 6, 5, 5, and 12 and its per-node `health.orphan` values are false.
Dashboard connectivity calls the graph builder with accepted pages but without
repository sources. Because all seven pages keep citations in the repository
rather than embedding source definitions, their citation targets are
unavailable in that projection; it reports `connectedPages=0` and
`orphanPages=7`. `directedLinks` also intentionally counts only forward
page-to-page wikilinks and dependencies.

Thus the two views are explainable but use different orphan semantics. In the
sense relevant to a knowledge graph, all seven pages are disconnected because
they contain no page references or relationships. Citation provenance does not
connect one durable learning to another.

There is no evidence of a failed graph index:

- the complete graph is untruncated and contains all pages and sources;
- deterministic navigation lists all seven accepted pages and all seven
  acceptance timestamps;
- every citation edge tested resolves to accepted evidence;
- accepted-page reads and lexical retrieval work;
- vector-ingest workflows show no current errors.

Graph sparsity is instead the combined result of only seven published pages,
compiler output that does not synthesize relationships, and the dashboard/full-
graph projection distinction above.

## Production configuration and persistence health

| Area              | Read-only production evidence                                                                                                       | Finding                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Worker deployment | Production is 100% on version `27f46461-0035-4ee4-88bb-b2b08fc73b3b`, an August 3 secret-change deployment backed by the August 3 code upload. | No split traffic or stale second version was visible.                                                                        |
| Durable Object    | Active version binds `MEMORY_VAULTS` to SQLite `TeamVaultObject`; page, source, FTS/navigation, dashboard, and graph reads succeed. | DO is reachable. Failure is localized to proposal validation/persistence.                                                    |
| R2                | `jingler-memory`, WEUR, Standard, 402 objects, approximately 990 kB. Source and accepted-revision reads succeed.                    | The recovery store is populated; no evidence of missing accepted blobs.                                                      |
| Compiler Workflow | Resource exists; all 168 deterministic public handles resolve: 160 errored, 7 published, and 1 running.                              | Durable invocation works; 160 terminal compiler errors are the primary observed loss, with the representative failure at step 05. |
| Lint Workflow     | Resource exists but Wrangler reports **zero instances**. Active bindings contain no `MEMORY_LINT_ORGANIZATIONS`.                    | Scheduled vault lint is effectively disabled for every organization.                                                         |
| Vector ingest     | 15 instances: 12 completed and 3 early terminated instances; no errored current instance. Daily sweeps ran on August 4–6.           | No evidence that advisory vector indexing caused graph sparsity.                                                             |
| Queue             | No Cloudflare Queue producer, consumer, or binding exists in the deploy contract. Source ingest starts Workflows directly.          | There is no queue backlog or DLQ to inspect; Workflow is the durable transport.                                              |
| Secrets/config    | Service, OpenAI, and turbopuffer secret names exist. The documented stable `MEMORY_WORKFLOW_ID_SECRET` is absent.                   | Current handles resolve, but a future service-secret rotation can change scoped Workflow instance IDs and weaken continuity. |
| Review gate       | `MEMORY_REQUIRE_REVIEW` is absent and accepted timestamps equal proposal timestamps.                                                | Default auto-publish explains zero-hour review latency; human review is not blocking publication.                            |

The public `compiler-fnv1a64:*` handles are organization-facing aliases. Wrangler
lists scoped Cloudflare instance IDs such as `team-*`, so attempting to describe
a public handle directly returns API code 10400 `not_found`; it does not mean the
public Workflow status is missing. Exact counts therefore come from the
organization-scoped deterministic status sweep, while Wrangler's scoped
instance detail supplies the representative step/retry/error trace.

## Unexplained or non-joinable deltas

- **One nonterminal source:**
  `session-digest:e6de2d90e97ee65065adae85ba4a53653c7e5bacc8a8f61793c84bf50c539782`
  mapped to `compiler-fnv1a64:62908030cc1a9dae` and remained `running` at the
  final status cut-off. It is included in the 168-source cohort but not assigned
  an eventual terminal outcome.
- **Six proposal calls versus six manual-proposal sources:** the dashboard stores
  aggregate proposal-call telemetry, while the hosted graph exposes distinct
  source records. The metric was already six when only two manual sources
  existed and did not visibly advance after four additional audit proposals
  published. Without a call-to-idempotency ledger, the equal current counts are
  not a valid join.
- **Public versus Wrangler Workflow IDs:** both namespaces identify working
  status surfaces, but the hosted API does not expose the `team-*` instance ID
  that corresponds to every public handle. This prevents a complete one-to-one
  Wrangler step trace even though all 168 public outcomes resolve.
- **Generic compiler errors:** hosted status and Wrangler retain state and retry
  timing but sanitize the underlying `MemoryLintError`. The duplicate-title
  cause is supported by deployed code, the generated source/page titles, the
  source-type outcome split, and a local reproduction, but not by an unsanitized
  production exception string.
- **R2 object count:** R2 contains immutable source, history, revision, and
  publication artifacts, so 402 objects are not expected to equal the 168
  logical source count. Wrangler exposes bucket totals but no safe object-list
  command; no object-by-object reconciliation was attempted.

## Conclusions

The hosted system is not failing to receive settled sessions. It is receiving
them and starting deterministic compiler workflows, then losing almost all
automatic memory creation at a repeatable proposal-validation boundary. This is
the dominant server-side explanation for only one automatically compiled
session page after 162 settled-session captures. The other six accepted pages
came from explicit proposals.

The current seven pages also cannot form a knowledge graph: none declares a
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
