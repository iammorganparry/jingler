# Memory creation audit — 2026-08-06

Plan: `449de134-ebee-4064-8574-3bf0ae274be7`, revision 68

Evidence cut-offs: transcript snapshot `2026-08-06T12:02:00Z`; hosted-state
reconciliation `2026-08-06T13:15:06.048Z`

## Executive conclusion

Jingler has two independent dominant memory-loss points.

1. **A capable agent is not reliably asked to make a creation decision.** In a
   reproducible cohort of 12 settled Codex and Claude transcripts, a conservative
   rubric found 58 durable-learning candidates and no explicit
   `memory_propose` or `memory_workflow_status` call. Thirty-eight candidates arose
   without a Jingler memory tool surface, but the result remained zero proposals
   for the 19 candidates that arose after memory was demonstrably exposed. The
   always-injected prompt provides no end-of-turn reflection and only says to
   “capture what's worth keeping”; the useful durability rubric lives in an
   optional skill that AgentRunner does not activate. This is the dominant loss in
   natural, agent-initiated creation. [Transcript evidence][T] [Pipeline evidence][P]

2. **Automatic settled-turn capture reaches the hosted system but cannot compensate.**
   The hosted organization had 162 settled-session sources: 160 compiler workflows
   errored, one published, and one was still running at the cut-off. The 0.62% raw
   session-source publication rate is explained with very high confidence by a
   duplicate-identity collision. Every digest is titled `Settled Jingler agent
   session`; the deterministic compiler copies that title to each unmatched new
   page; after the first page was accepted, full-vault lint rejected subsequent
   pages. The deployed boundary hides the typed lint cause, but the source-type
   outcome split, deployed code path, retry step, and local reproduction all agree.
   [Hosted evidence][H] [Pipeline compiler evidence][PC]

These failures occur before retrieval or graph quality can compound. Only seven
pages were accepted from 168 total sources. The dashboard's recorded zero-result
search ratio was 83.21%. The accepted pages had 42 page-to-source citation
occurrences but zero durable page-to-page links, so all seven were disconnected as
knowledge even though their provenance was intact. This is expected from compiler
output with `relationships: []` and no wikilinks, not evidence of a missing graph
index. [Hosted graph evidence][HG] [Pipeline graph evidence][PG]

The immediate priority is therefore not broader automatic publication. First make
every captured source reach a typed terminal outcome, repair page identity, add a
valid `no_durable_learning` outcome, and instrument the complete funnel. Then add a
silent, bounded end-of-turn reflection rubric and measure proposal recall and human
precision. Structured automatic extraction should remain shadowed or review-gated
until it demonstrates zero sensitive-data escapes and high accept-as-is precision.

## Reconciled causal funnel

The transcript, hosted, and implementation reports observe different units. When
their denominators are kept separate, they form one causal funnel:

| Path | Observed input | Creation decision | Hosted outcome | Durable result |
| --- | ---: | --- | --- | --- |
| Explicit agent path | 58 labeled candidates in 12 settled transcripts | 0 explicit proposals; 0 workflow polls | Not entered by the cohort | 0 cohort-attributable pages |
| Exposed subset | 19 candidates after memory exposure | 0 explicit proposals | Not entered | 0 cohort-attributable pages |
| Pre-exposure subset | 38 candidates without a Jingler tool surface | Proposal impossible in that turn | Not entered | 0 cohort-attributable pages |
| Automatic session path | 162 hosted settled-session sources | Deterministic compiler invoked | 160 errored, 1 published, 1 running | 1 accepted page at cut-off |
| Manual proposal-source path | 6 distinct hosted proposal sources | Compiler invoked | 6 published | 6 accepted pages |
| Accepted graph | 7 accepted pages | Citations extracted | 42 citation occurrences | 0 page-to-page links; 0 connected pages in dashboard semantics |

Long sessions are where most reusable knowledge accumulated: the eight ranked-long
transcripts contained 51 of 58 candidates (87.9%), versus seven in four comparison
transcripts. This supports adding bounded reflection to long work without inventing
a minimum turn-count threshold. Candidate density by transcript was 6.38 for the
long cohort and 1.75 for the comparison cohort. The rubric count is a conservative
human judgment, not a production classifier. [Transcript cohort][TC]

### Apparent contradictions resolved

| Apparent conflict | Resolution |
| --- | --- |
| The transcript cohort has zero proposals, while the dashboard records six proposal calls. | The cohort and dashboard cover different scopes and time ranges. Dashboard telemetry counts calls; hosted state now exposes six manual-proposal sources, but the equality is not a join: telemetry was already six when only two sources existed and did not visibly advance after four audit proposals published. |
| Current code attaches memory deterministically, while 38 candidates are classified as tool-unavailable. | Attachment is conditional on feature access, billing, organization selection, successful grant/discovery/proxy setup, and rollout timing. Most sampled unavailable turns predate exposure; current code does not retroactively provide a tool. |
| Automatic capture is working, yet memory creation is sparse. | Capture means a redacted source was stored. Compilation, proposal persistence, publication, and graph linking are separate gates. The hosted source count proves receipt, not accepted memory. |
| The full graph can mark page nodes non-orphan while the dashboard reports seven orphan pages. | The full graph includes source nodes, so citation edges contribute page degree. Dashboard connectivity intentionally omits repository sources and counts page-to-page wikilinks/dependencies. Both projections report zero durable page relationships. |
| Focused tests pass, while production compilers fail. | No test executes the production sequence “accept one generic-title session page, then compile a second.” The missing sequence is the specific coverage gap; the local two-page lint reproduction fails as production behavior predicts. |
| Every deterministic handle resolved, yet one hosted workflow was nonterminal. | Resolution means the handle exists, not that it settled. The frozen source `session-digest:e6de2d90…` remained `running`; it is included in the 168-source partition without an inferred later outcome. |

The 12 transcripts cannot be joined one-for-one to the 162 hosted session sources
with the exposed audit APIs, so this report does not claim that a particular sampled
candidate became a particular source. The two paths are causally linked by inspected
code and independently quantified at their own boundaries.

## Ranked root causes

Confidence labels combine direct observation, implementation evidence, and whether
the attribution was reproduced. “Falsifying evidence” states what would materially
weaken the diagnosis; it is not evidence currently observed unless noted.

| Rank | Root cause and loss point | Confidence | Supporting evidence | Limiting or falsifying evidence |
| ---: | --- | --- | --- | --- |
| 1 | **Generic session identity makes the automatic fallback fail at proposal lint.** | Very high | 160/162 session workflows errored; a representative failed run reached and exhausted retries at step `05-lint-and-persist-proposal`; the first generic-title session page and all six differently titled manual sources published; code copies the source title; a two-page reproduction raises two duplicate-identity findings. [Transcript capture boundary][T] [Hosted failure diagnosis][HC] [Compiler code audit][PC] | Production exposes only a generic 500, not the underlying lint string. Unsanitized production evidence naming a different validation cause, or continued step-05 failure after unique identity is deployed, would weaken this attribution. |
| 2 | **Natural creation has no reliable end-of-turn trigger and a materially thin durability policy.** | High | Zero proposals for 58 candidates, including zero for 19 candidates after memory exposure. The injected prompt has no reflection step, examples, or durable-versus-ephemeral rubric; the richer optional skill is not activated. [Transcript tool traces][TT] [Hosted manual-source outcomes][HF] [Creation-policy audit][P] | Thirty-eight candidates had no tool surface, so they cannot establish prompt failure. Six hosted manual proposal sources published, proving that explicit proposal works when initiated. A controlled prompt-only experiment with unchanged proposal yield would falsify the proposed mechanism. |
| 3 | **Historical/tool-eligibility gaps removed the explicit creation path for most sampled candidates.** | High for the cohort; medium for current impact | 38/58 candidates were classified tool-unavailable at the exact turn; sampled native logs establish exposure timing. Access also depends on paid membership, selection, discovery, and fail-open proxy setup. [Transcript missed examples][TM] [Hosted source receipt][HF] [Launch-gate audit][PL] | AgentRunner now supports Claude, Codex, and OpenCode per turn once prerequisites hold. A current, eligibility-filtered sample showing the attachment on every turn would make this historical rather than an active cause. No mapped OpenCode cohort exists. |
| 4 | **Compiler extraction cannot distinguish durable learning from transcript shape and cannot succeed with no work.** | Very high for implementation; medium for production impact | Any deduplicated 12–600 character line can become one of 12 claims; digest labels pass; zero claims errors; there is no no-op. The only accepted session page contains empty labels and progress narration. The strong compiler prompt is constructed but not consumed by the production deterministic model. [Transcript durability rubric][T] [Accepted session page][HA] [Compiler code audit][PC] | Only one accepted automatic page is available for quality judgment. A blinded larger sample could show higher precision than this page suggests, but it would not change the implementation facts. |
| 5 | **Optional persistence hooks are marker-gated, separately credentialed, and unobservable.** | Very high for implementation; medium for production contribution | Jingler does not install the hooks. They require separate URL/token/org variables and a note, argument, or visible `MEMORY:` marker that normal prompts do not request. The response and workflow handle are discarded. [Transcript capture-behavior example][TM] [Hosted non-joinable proposal telemetry][H] [Hook audit][PH] | The audit cannot enumerate private user hook configurations. A user may have configured explicit notes successfully, but no sampled renderer proposal trace establishes that path. |
| 6 | **Failure boundaries hide permanent causes and delay detection.** | High | `MemoryLintError` becomes generic `internal_error`; a permanent failure retries six times; capture success means local enqueue; the outbox has no independent timer; proposal-call telemetry cannot be joined to unique sources; scheduled lint has no organizations configured; the stable workflow-ID secret is absent. [Transcript outbox limitation][T] [Production health][HP] [Compiler boundary audit][PC] | These defects amplify time-to-diagnosis rather than directly creating the duplicate. Typed errors alone will not increase yield unless root causes are repaired. |
| 7 | **Compiler output contains no durable relationship signal.** | Very high | All seven accepted pages have empty relationships and no wikilinks; the graph has zero page-to-page edges. Code derives the graph correctly and the compiler always emits `relationships: []`. [Transcript distinction between capture and proposal][T] [Hosted graph][HG] [Graph code audit][PG] | Seven pages are still a small graph, and valid memories need not all connect. Evidence-backed links generated by a revised compiler would falsify this as an ongoing cause; arbitrary connectivity would not. |
| 8 | **Existing-page proposals have different settlement semantics from new-page proposals.** | Very high for implementation; unquantified in production | New pages enter a compiler Workflow and inherit its auto-publish/review policy. Existing-page updates create an open direct proposal, return no Workflow handle, and require a privileged review. [Transcript zero-poll baseline][TT] [Hosted review states][H] [Direct-proposal audit][PD] | No hosted existing-page update was observed in this audit, so the resulting accepted-yield loss is not measured. It is a policy mismatch, not an explanation for the 160 session failures. |

Ranks 1 and 2 are independently sufficient to keep accepted memory sparse: fixing
only the prompt leaves automatic compilation broken, while fixing only the compiler
still leaves natural agent judgment at zero in the measured cohort.

## Ranked remediation portfolio

Yield estimates refer to durable accepted memory, not raw source volume. Precision
risk means the chance of publishing low-value, duplicate, or incorrect memory.

| Priority | Remediation | Expected yield | Precision risk | Cost | Privacy impact | Observability gain |
| ---: | --- | --- | --- | --- | --- | --- |
| 0 | Give every source a typed, joinable funnel event and expose lint causes; alert on error ratio and stuck workflows. | Indirect, high | Low | Medium | Low if telemetry is aggregate and content-free | Very high |
| 1 | Replace generic new-page identity with deterministic unique identity plus explicit update/merge/no-op selection; do not retry permanent lint failures. | Very high | Low; no-op improves precision | Medium | Neutral | High |
| 2 | Add a silent end-of-turn reflection rubric to the always-injected prompt; bound to three standalone candidates, require search/read dedupe and terminal polling. | High | Medium | Low–medium | Medium; agent may surface sensitive facts unless exclusions are strict | High |
| 3 | Add durability scoring, digest-label exclusion, semantic candidate matching, and `no_durable_learning`; either use the compiler prompt in a constrained model or remove it as dead policy. | High | Low–medium after review | Medium–high | Medium | High |
| 4 | Align new- and existing-page proposal handles, status, review, and publication semantics. | Medium | Low | Medium | Neutral | High |
| 5 | Replace visible marker persistence with an internal structured reflection/candidate channel; retain compatibility hooks but make their result and workflow settlement observable. | Medium | Medium | High across harnesses | Medium | High |
| 6 | Run structured settled-turn extraction in shadow mode, then human review, with source-type publication policy. | Very high | High | High | High; automatic inference broadens capture | Very high |
| 7 | Generate resolvable, evidence-backed relationship candidates and review them separately from factual page content. | No direct page yield; high reuse value | Medium | Medium | Low | Medium |

### Immediate observability and correctness fixes

These should land before changing agent behavior:

- Persist a content-free transition ledger keyed by organization, source ID,
  workflow ID, proposal-set ID, and publication ID. Record `captured`, `delivered`,
  `compiled_noop`, `pending_review`, `published`, `rejected`, `conflicted`, and
  typed `failed` states plus timestamps and source kind.
- Map `MemoryLintError` and its issue codes to a non-secret terminal validation
  result. Retry network/transient errors only; a deterministic duplicate identity
  should fail once.
- Make source-derived page identity unique and stable without using the generic
  display title as an identity. Before creating a page, choose one of: update an
  accepted candidate, create a unique page, or return `no_durable_learning`.
- Add a regression test that publishes one generic-title session page, compiles a
  second source with that title, and proves it updates, creates a unique page, or
  no-ops without error.
- Record outbox enqueue, delivery, attempt, expiry, and membership-drop counters so
  an eligible `Done` can be joined to hosted receipt without retaining transcript
  content. Add a periodic drain or an explicit lifecycle owner rather than relying
  only on future access.
- Configure a stable `MEMORY_WORKFLOW_ID_SECRET`, configure the lint organizations,
  and label the dashboard's citation connectivity separately from durable page
  connectivity.

### Safe memory-yield improvements

After the source pipeline settles reliably:

- Put the skill's rubric into the always-injected prompt. Before ending a
  non-trivial turn, the agent should silently identify at most three standalone
  decisions, preferences, gotchas, connections, or hard-won findings. It should
  exclude documented facts, progress, temporary paths, credentials, personal data,
  and claims corrected later in the turn.
- Require a search and full accepted-page read before proposal so a candidate can
  update existing knowledge or be dropped as duplicate. Require every returned
  Workflow handle to be polled to a typed terminal state. The UI need not narrate
  these internal steps.
- Apply the reflection once per settled turn, not once per transcript length
  threshold. Bound candidate count and content size so long sessions gain recall
  without proposal spam.
- Make direct existing-page updates return an observable handle or an equally
  explicit terminal `pending_review` result. “Auto-accept by default” must describe
  both routes accurately or be narrowed in the instructions.
- Keep all session-derived compilation review-gated during the experiment. Explicit
  agent proposals may be evaluated as a separate source class because the two
  observed manual sources succeeded and are more intentional.

### Higher-risk automatic extraction

Automatic extraction should be a separate experiment, not a hidden extension of
source capture:

- Build a structured candidate record containing one claim, its exact settled
  evidence span, durability reason, sensitivity class, likely page identity, and
  proposed relationships. A valid empty result is required.
- Run it in shadow mode over a fixed, redacted corpus labeled with the transcript
  rubric. Measure candidate recall, accept-as-is precision, duplication, sensitivity
  escapes, and disagreement by harness and session length.
- In review mode, prevent raw transcript labels and progress narration from becoming
  claims. Use accepted page bodies and aliases for candidate matching, not identity
  fields alone.
- Do not auto-publish inferred preferences, people/process facts, security findings,
  credentials, personal data, or low-confidence contradictions. Those categories
  remain review-only even after low-risk facts qualify for automatic publication.

### Evidence-backed graph linking

Graph work follows page-quality work:

- Treat citations as provenance only. Track `citationEdges` and
  `durablePageEdges` as distinct metrics and never use source degree to claim that
  durable pages are connected.
- Generate a relationship only when both accepted page IDs resolve and a cited
  evidence span supports the typed relationship. Keep vector/topic similarity as a
  suggestion, never an accepted edge.
- Review relationship candidates independently. Preserve zero broken links and
  sample edge precision; do not create links merely to hit a connectivity target.

## Acceptance metrics and targets

Metrics must be segmented by harness, source kind, organization, experiment arm,
and session-length cohort. Content-free identifiers may join stages; raw text and
credential-shaped content must not enter analytics.

Definitions:

- **Durable-positive candidate** — a blinded reviewer says the transcript item
  passes the settled rubric used by the transcript audit.
- **Accept-as-is** — a reviewer accepts the proposed standalone fact without
  material factual, privacy, identity, or relationship edits.
- **Durable page edge** — a resolvable page-to-page wikilink, dependency, or schema
  relationship; a source citation does not count.
- **Eligible Done** — an adapter `Done` with memory enabled, a selected eligible
  organization, and a settled non-streaming assistant message.

| Metric | Formula | Frozen baseline | Target / guardrail |
| --- | --- | --- | --- |
| Explicit proposal recall | Labeled exposed candidates represented by a standalone submitted proposal / all labeled exposed durable-positive candidates | 0/19 (0%); 0/58 if unavailable turns are included | At least 60% in a weekly blinded sample and at least one proposal from 75% of candidate-positive long sessions; never exceed three proposals per Done |
| Workflow polling completeness | Returned handles with a recorded terminal poll / returned handles | Cohort has 0/0; optional hook discards every handle | 100% for agent and hook routes |
| Settled-source delivery | Eligible Done sources visible hosted within 10 minutes / eligible Done sources enqueued | Not historically joinable | At least 99%; zero silent expiry or max-attempt drops |
| Session compiler error rate | Errored session-source workflows / captured session-source workflows after a fixed settlement window | 160 errors; 1 published; 1 running at cut-off (98.8% of captured session sources errored) | Under 1%; permanent validation failures make one attempt and carry a typed cause |
| Terminal settlement | Sources in `published`, `no_durable_learning`, `pending_review`, `rejected`, `conflicted`, or typed `failed` within 10 minutes / delivered sources | 167/168 platform-terminal at cut-off, but 160 states were generic errors rather than typed explainable outcomes | At least 99%; no generic `internal_error` for known validation classes |
| Durable-positive accepted-page yield | Durable-positive sources producing an accepted revision / reviewed durable-positive sources | Not recoverable; raw session publication was 1/162 and the page was low quality | At least 60% during review rollout; remaining outcomes are explicit no-op/reject/conflict, not workflow error |
| Review precision and rejection | Accept-as-is / reviewed proposals; rejection / reviewed proposals | 7/7 auto-accepted, therefore not an informative quality baseline | At least 85% accept-as-is and at most 15% rejected before expansion; automatic-publication gate is stricter below |
| Sensitive-data escape | Proposed or accepted items containing prohibited credentials, personal data, or private material | No sampled candidate retained credential-bearing setup; semantic classifier coverage is unknown | Zero in shadow, review, and publication samples; any escape stops rollout |
| Exact and near duplication | Duplicate accepted identities or reviewer-labeled near duplicates / accepted pages | Zero accepted duplicate identities, but 160 workflows are attributed to preventing a duplicate generic identity | Zero exact duplicates; at most 2% near duplicates; zero duplicate-identity workflow failures |
| Search zero-result rate | Dashboard zero-result searches / recorded searches, segmented by known-memory vs exploratory queries | 0.8321 (83.21%) | At most 60% after 25 high-quality pages and 40% after 100; known-memory test set has at least 90% top-three recall and 100% successful full-page reads |
| Durable graph connectivity | Pages incident to at least one durable page edge / accepted pages | 0/7; 0 directed links; 7 dashboard orphans | At least 50% after 25 pages and 75% after 100, while sampled edge precision is at least 90% and broken links remain zero |
| Funnel explainability | Proposal calls and sources joinable to a typed terminal state / proposal calls and sources | Six telemetry calls and six manual sources currently have no stable join; the metric did not advance with four later publications | At least 99%; every unexplained delta is alerted and bounded |

Targets are deliberately not “publish every settled session.” A high no-op rate can
be healthy when a turn contains no reusable learning. Accepted-page yield is judged
only against durable-positive sources, while settlement is judged against every
delivered source.

## Staged rollout and stop conditions

Each stage changes one major mechanism so its effect can be attributed.

### R0 — Instrument and freeze the baseline

- Add joinable funnel events, typed failures, source-kind segmentation, privacy
  counters, and dashboard definitions.
- Keep current publication behavior unchanged while validating metrics on a fixed
  observation window.
- Exit when at least 99% of new sources have explainable terminal state and no audit
  field contains transcript content.

### R1 — Repair compiler identity under review

- Ship unique identity, merge/update/no-op selection, permanent-error handling, and
  the two-generic-source regression test.
- Route all automatically captured session sources to human review or shadow output;
  do not replay historical failures directly into accepted memory.
- Evaluate at least 100 historical redacted sources in shadow and 100 new candidates
  in review. Exit only with under 1% workflow errors, zero sensitive escapes, and at
  least 85% accept-as-is precision on durable-positive proposals.

### R2 — Add agent reflection to a controlled arm

- Add the bounded silent rubric and terminal polling for 10% of eligible sessions;
  leave compiler extraction unchanged so proposal initiation is isolated.
- Compare candidate recall, proposal volume, rejection, and latency against a
  control arm for at least two weeks or 100 labeled candidates, whichever is later.
- Expand to 25%, 50%, then 100% only when explicit proposal recall is at least 60%,
  rejection is at most 15%, and proposal volume stays at or below three per Done.

### R3 — Shadow structured automatic extraction

- Run the structured extractor with no publication side effects against the same
  blinded rubric. Compare deterministic rules and any constrained-model approach.
- Promote to review-only at 10% only after zero sensitivity escapes, at least 85%
  accept-as-is precision, and at most 2% near duplicates over 200 candidates.
- Keep high-risk categories permanently review-only.

### R4 — Permit narrow automatic publication

Low-risk session-derived facts may enter a 10% automatic-publication arm only after
**two consecutive weekly samples totaling at least 200 reviewed candidates** meet
all of these gates:

- at least 95% would have been accepted as-is;
- at most 2% are near duplicates and no exact duplicate is accepted;
- workflow error rate is under 1%;
- no credential, personal-data, sensitive-preference, or security-detail escape;
- every page has resolvable provenance and every handle has a terminal status.

Expand 10% → 25% → 50% → 100% with a fresh weekly review sample at each step. Stop
and return the source class to review on any sensitive escape, workflow errors above
1% for an hour with at least 20 sources, rejection above 15%, near duplication above
2%, broken evidence, or unexplained funnel delta above 1%.

### R5 — Introduce reviewed relationships

- Generate relationship candidates only after at least 25 high-quality pages exist.
- Review the first 100 edges. Expand only at 90% or better edge precision, zero
  broken targets, and no evidence that source citations are being counted as page
  links.

## Implementation-ready follow-up stages

This audit changes no prompt, hook, compiler, production configuration, or hosted
state. Implementation requires a separately approved/amended plan. Recommended
stages are:

### F1 — Funnel observability and identity repair

- Worker: typed lint outcomes, transient/permanent retry classification, unique
  page identity, update/create/no-op result, stable workflow IDs.
- Desktop/server: joinable outbox and delivery telemetry without content.
- Dashboard: explicit source-citation versus durable-link metrics and source-kind
  conversion.
- Tests: second generic session source after an accepted first page; idempotent
  replay; no-op; typed failure; Workflow status; R2/DO recovery; outbox delivery and
  expiry. If dashboard/UI changes are user-facing, add the required built-Electron
  Playwright spec under `apps/desktop/e2e/`.

### F2 — Natural agent reflection and proposal settlement

- Put the durable-learning rubric and silent end-of-turn reflection into the
  always-injected prompt for all supported harnesses.
- Bound candidates, require search/read dedupe, align update semantics, and poll
  every handle.
- Tests: prompt placement for slash/skill commands; proposal/no-proposal examples;
  duplicate update; pending review; terminal failure; Claude, Codex, and OpenCode
  attachment. Add a built-Electron end-to-end test in which a scripted harness
  discovers one hard-won fact, proposes it, polls settlement, and does not narrate
  memory use.

### F3 — Compiler quality and privacy experiment

- Add structured candidate/no-op output, digest-label filtering, body-aware matching,
  source-type review policy, and semantic sensitivity classification.
- Decide explicitly whether the compiler prompt is executed by a constrained model
  or replaced by deterministic policy; do not leave unenforced prompt text.
- Tests: rubric positives/negatives, corrected claims, personal data, credential
  shapes, labels/progress narration, contradictions, merge, no-op, and review.

### F4 — Evidence-backed graph relationships

- Generate typed relationship candidates with accepted evidence, resolvable target
  IDs, and independent review state.
- Tests: page-to-source citations remain distinct; wikilink/backlink and dependency
  pairs; unresolved target rejection; relationship evidence; dashboard projection.
  Add Electron e2e coverage if review or graph UI changes are exposed.

### F5 — Controlled rollout and operations

- Add experiment allocation, review sampling, alerts, automatic stop conditions,
  weekly quality reports, and reversible source-type publication policy.
- Validate `pnpm lint`, `pnpm typecheck`, `pnpm test`, focused Worker/server/adapter
  suites, and the required Electron e2e before each user-facing release.

## Evidence appendix

### Primary reports

- **T — Transcript evidence:** [Recent-session memory creation audit][T] uses the
  renderer-visible transcript as its authoritative store, defines a reproducible
  nine-day window and settlement filter, labels all 12 sampled transcripts with a
  conservative rubric, and counts explicit memory tools. Its key observations are
  58 candidates, 11 searches, seven navigation reads, and zero reads, proposals, or
  status polls. [Cohort and rubric][TC] [Tool traces][TT] [Missed examples][TM]
- **H — Hosted evidence:** [Hosted Cloudflare memory-state audit][H] freezes a
  168-source funnel at `2026-08-06T13:15:06.048Z`, reads all seven accepted pages,
  resolves all deterministic Workflow handles, inspects production configuration,
  and distinguishes citation edges from durable page relationships.
  [Funnel][HF] [Accepted pages][HA] [Failure diagnosis][HC] [Persistence health][HP]
- **P — Code/policy evidence:** [Memory integration and creation-policy audit][P]
  traces launch, attachment, settlement capture, hooks, compiler, publication,
  indexing, and graph extraction. Focused adapter, server, and Worker suites passed;
  loopback-dependent adapter tests passed with local binding permitted.
  [Launch gates][PL] [Direct proposals][PD] [Hooks][PH] [Compiler][PC]
  [Verification][PV]

### Representative transcript traces

All examples below came from transcripts that passed the settled filter; excerpts
were minimized and credential-shaped content excluded in the source audit.

| Evidence | Reusable learning | Preliminary loss category |
| --- | --- | --- |
| Signals Widget, turn 24 | Deduplication identity is the evidence set, not a time bucket. | Agent judgment after successful memory search |
| GitHub Rework, turns 26–29 | Offline replay must be session-scoped; Durable Objects own session state and Workflows own retry/orchestration. | Agent judgment after prompt/recall exposure |
| Screenshot Attachment, turn 1 | Steered screenshot files must outlive asynchronous harness ingestion. | Agent judgment after exposure |
| Onboarding Performance, turn 46 | Multi-provider image fallback state must reset when the connector identity changes. | Agent judgment after late exposure |
| TypeScript upgrade, turn 13 | An aliased dependency can win the workspace `.bin/tsc` slot and defeat an intended compiler upgrade. | Tool unavailable at that turn |
| Signals Jarvis, turn 22 | Prose saying a finding was “stored to memory” is not persistence evidence without a proposal trace. | Capture behavior |

The complete representative table and per-category counts are in the
[transcript report][TM].

### Code landmarks

These paths are evidence landmarks, not implementation changes:

| Behavior | Source landmark |
| --- | --- |
| Thin always-injected policy | `packages/cli-adapters/src/memory-prompt.ts` |
| Per-turn attachment, recall, outbox, generic session title | `packages/cli-adapters/src/memory.ts` |
| Capture only after adapter `Done` | `packages/cli-adapters/src/agent-runner.ts` |
| MCP proposal routing and initialization instructions | `apps/server/src/mcp-memory.ts` |
| Marker-gated compatibility persistence | `skills/jingler-team-memory/hooks/persist.sh` |
| Claim extraction, deterministic compiler, generic title copy, empty relationships, step-05 lint | `apps/memory-worker/src/workflows/compiler.ts` |
| Generic Worker error boundary and review policy | `apps/memory-worker/src/api.ts` |
| Accepted state, FTS context, proposal lint/publication | `apps/memory-worker/src/team-vault.ts` |

### Focused verification carried forward

The implementation audit recorded these canonical results:

- adapter prompt/MCP/memory: 3 files and 38 tests passed;
- AgentRunner memory: four focused tests passed with loopback permitted;
- memory MCP proxy: four tests passed after removing the inherited sandbox skip;
- server: 12 files and 102 tests passed, including hook and MCP tests;
- memory Worker: five focused files and 47 tests passed, including compiler, API,
  vault, graph, and vector-ingest coverage.

The exact commands are preserved in [pipeline verification][PV]. A broader package
run hit two five-second TeamVault timeouts under parallel load; both tests passed
alone and the properly targeted 47-test run passed. No test covers two successive
generic-title session compilations after accepting the first.

### Residual uncertainty

- The sampled transcripts and hosted sources cannot be joined by the exposed audit
  interfaces; candidate-to-page attribution is intentionally not claimed.
- Proposal-call telemetry cannot be joined to source records: it remained six while
  manual sources grew from two to six after four audit proposals published.
- The duplicate-title cause is not present in an unsanitized production exception;
  it is supported by code, exact workflow step, outcome distribution, and local
  reproduction.
- The newest hosted session Workflow remained running at the cut-off.
- No mapped Jingler OpenCode session existed in the transcript window, so no natural
  OpenCode proposal judgment is measured.
- The rubric is manual and conservative. Targets require continued blinded sampling,
  not treating this 12-transcript cohort as a permanent benchmark.

## Settled reusable system findings

Five conclusions are sufficiently settled and standalone for shared-memory
proposal after this report is written:

1. Natural Jingler memory creation needs an always-injected, bounded end-of-turn
   durability rubric; tool attachment alone produced zero proposals for 19 exposed
   candidates in the settled audit cohort.
2. Automatic settled-session compilation currently fails after the first generic
   session page because the shared source title becomes a duplicate page identity;
   the hosted cut-off observed 160 errored, one published, and one running session
   Workflow.
3. The deterministic compiler uses line shape rather than durability, has no valid
   no-op, does not consume its constructed compiler prompt, and emits no page
   relationships.
4. Jingler graph citation edges prove provenance but are not durable page-to-page
   relationships; all seven accepted pages had citations and zero durable links.
5. Automatic memory publication must remain gated until at least 99% of the funnel
   is explainable, session compiler errors are under 1%, reviewed proposals are at
   least 85% accept-as-is, near duplicates are at most 2%, and sensitive-data
   escapes are zero; a sensitive escape or unexplained delta above 1% stops rollout.

### Shared-memory publication result

At `2026-08-06T12:59:12Z`, organization-scoped pre-proposal searches returned no
accepted match for any of the four findings. Each standalone proposal then returned
a Workflow handle, and every handle was polled to `state=complete` with
`result.status=published`. A final graph lookup plus `memory_read` resolved all four
accepted pages and their stable evidence identifiers:

| Finding | Workflow / terminal state | Accepted page and revision | Source / citation |
| --- | --- | --- | --- |
| Natural creation trigger | `compiler-fnv1a64:28b8e4187955ecbc` / `complete:published` | `learning-fnv1a64:0784` / `revision:proposal:compiler-fnv1a64:28b8e4187955ecbc:page:learning-fnv1a64%3A0784` | `source:proposal-f1eb1509d4db634cfe0e9604423adaca92c8e0d127bec91e44fba2e8f37cb2c1` / `compiler-fnv1a64:0784` |
| Generic session-title collision | `compiler-fnv1a64:90254587584303bd` / `complete:published` | `learning-fnv1a64:acba` / `revision:proposal:compiler-fnv1a64:90254587584303bd:page:learning-fnv1a64%3Aacba` | `source:proposal-ddae5d76ace5bc62ec4532c2fc57e4c2c10f18884e9c0610541be0888057b0cc` / `compiler-fnv1a64:acba` |
| Compiler policy gaps | `compiler-fnv1a64:e22781acd8f4ad4b` / `complete:published` | `learning-fnv1a64:3963` / `revision:proposal:compiler-fnv1a64:e22781acd8f4ad4b:page:learning-fnv1a64%3A3963` | `source:proposal-46bc923231e3a6e787cf70d76b579595534f6fdb29907efb1cbcb52841219d62` / `compiler-fnv1a64:3963` |
| Citation versus durable links | `compiler-fnv1a64:907b62f499e2e7` / `complete:published` | `learning-fnv1a64:a8df` / `revision:proposal:compiler-fnv1a64:907b62f499e2e7:page:learning-fnv1a64%3Aa8df` | `source:proposal-ee656262ceb16e2dde2f780fd60936e10c50f1b7d180edb22a34cb567de788af` / `compiler-fnv1a64:a8df` |
| Safe automatic-publication gates | `compiler-fnv1a64:7b64f2895ccb796d` / `complete:published` | `learning-fnv1a64:6139` / `revision:proposal:compiler-fnv1a64:7b64f2895ccb796d:page:learning-fnv1a64%3A6139` | `source:proposal-d6c4bc50ceb6823577315c54a65a600f9a6655fc0b5bda717bdb3fa26feaf3dc` / `compiler-fnv1a64:6139` |

These four publications happened after the earlier revision-2 hosted cut-off but
before the refreshed revision-68 snapshot. They are therefore included among the
current six manual sources and seven accepted pages. They verify the explicit
manual-proposal path and remain excluded from the 162-source automatic-session
failure rate.

At `2026-08-06T13:42:45.127Z`, a pre-proposal search found no accepted equivalent
for the fifth, rollout-policy finding. Its proposal returned Workflow
`compiler-fnv1a64:7b64f2895ccb796d`; repeated idempotent submission retained that
same handle, and polling settled at `complete:published`. Exact-title search
resolved the accepted page and revision shown above, and `memory_read` verified its
source and citation identifiers. This fifth publication is after the frozen hosted
cut-off, so it is durable evidence for this synthesis but does not change the
168-source, seven-page baseline or any rate calculated from it.

[T]: memory-creation/transcript-findings.md
[TC]: memory-creation/transcript-findings.md#reproducible-cohort
[TT]: memory-creation/transcript-findings.md#explicit-memory-tool-traces
[TM]: memory-creation/transcript-findings.md#representative-missed-memory-traces
[H]: memory-creation/hosted-findings.md
[HF]: memory-creation/hosted-findings.md#capture-to-publication-funnel
[HA]: memory-creation/hosted-findings.md#every-accepted-page-and-stable-evidence-identifiers
[HC]: memory-creation/hosted-findings.md#compiler-failure-diagnosis
[HG]: memory-creation/hosted-findings.md#graph-citations-and-why-the-pages-are-disconnected
[HP]: memory-creation/hosted-findings.md#production-configuration-and-persistence-health
[P]: memory-creation/pipeline-findings.md
[PL]: memory-creation/pipeline-findings.md#end-to-end-launch-and-recall-path
[PD]: memory-creation/pipeline-findings.md#direct-proposals-and-optional-post-turn-hooks
[PH]: memory-creation/pipeline-findings.md#hook-behavior-by-harness
[PC]: memory-creation/pipeline-findings.md#compilation-gates
[PG]: memory-creation/pipeline-findings.md#graph-relationship-extraction
[PV]: memory-creation/pipeline-findings.md#focused-verification
