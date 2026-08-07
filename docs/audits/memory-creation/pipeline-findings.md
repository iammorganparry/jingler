# Memory integration and creation-policy audit

Audit date: `2026-08-06`

## Executive finding

Jingler reliably attempts recall and source capture once a user has selected an
eligible organization, but it does not reliably cause an agent to make an explicit
memory proposal. Tool attachment and bounded pre-turn recall are owned by the
runner and are deterministic. Direct proposal creation is model-mediated, has no
end-of-turn reflection step, and receives only the phrase “capture what's worth
keeping” in the always-injected prompt. The detailed durable-learning rubric lives
in the optional `jingler-team-memory` skill, which Jingler does not install or
activate as part of a launch.

The optional post-turn hooks do not close that gap by default. They are
configuration examples rather than an AgentRunner integration, need a separately
exported PAT and organization, and submit only an explicit environment/argument
note or a visible `MEMORY:` line. Neither Jingler's injected prompt nor the MCP
instructions ask agents to emit that marker; the injected prompt instead says to
keep memory use silent. The hooks also discard the compiler handle and never poll
it.

Automatic settled-session capture is deterministic after a successful `Done`, but
it is a different mechanism from agent judgment. It captures nearly every settled
turn, not only durable learnings. Its deterministic compiler treats any 12–600
character line as a claim, including digest labels such as `Harness: codex` and
`Settled outcome:`. It has no “no durable learning” outcome. In production this
broad capture is then mostly suppressed by an implementation collision: every
session digest has the title `Settled Jingler agent session`, the compiler copies
that title to an unmatched new page, and full-vault lint rejects every later page
with the duplicate identity. The hosted audit observed 160 errored session
workflows, one published session workflow, and one session workflow still running
at its final cut-off.

The graph is not a separate failing index. It is re-derived from accepted evidence
on every graph read. The deterministic compiler emits citations but always leaves
`relationships: []` and does not add wikilinks, so automatically compiled pages can
have source edges while remaining disconnected from every other durable page.

## Scope and evidence

This audit traced the current source tree from `AgentRunner` through the three
launchable harness adapters, the public Next.js memory boundary, the Cloudflare
Worker, Workflows, Durable Object, R2, FTS projection, vector sidecar, and graph
builder. It also inspected the distributable skill and both hook configurations.
No prompt, hook, compiler threshold, production setting, proposal, or hosted state
was changed.

The production outcomes cited here come from the read-only
[hosted-state audit](./hosted-findings.md), whose final reconciliation cut-off was
`2026-08-06T13:15:06.048Z`. The natural proposal observations come from the
[transcript audit](./transcript-findings.md), whose reproducible 12-transcript
cohort contained 58 durable-learning candidates and zero `memory_propose` or
`memory_workflow_status` calls. The hosted cohort contains 168 sources: 162
settled-session digests and six explicit proposals, partitioning into 160 errored,
seven published, and one running compiler outcome.

Gate labels used below are:

- **Deterministic** — Jingler or the service executes the gate in code whenever
  its prerequisites hold.
- **Best-effort** — failure is swallowed, or action depends on model judgment.
- **Marker-gated** — an explicit note or transcript marker is required.
- **Settlement-gated** — only a successfully completed turn reaches the gate.
- **Workflow-gated** — Cloudflare Workflow state, review, lint, or publication
  must settle before accepted memory exists.

### Creation-gate inventory

| Boundary | Classification | Required condition / outcome |
| --- | --- | --- |
| Feature and organization eligibility | Deterministic | Hosted memory is enabled; the signed-in user belongs to an eligible paid organization; and the workspace has memory enabled with that exact organization selected. |
| Grant, discovery, and private proxy | Best-effort | A short-lived organization grant, server discovery, and loopback registration must finish inside the fail-open attachment budget. |
| Harness tool attachment | Deterministic after attachment | AgentRunner adds `jingler-memory` first and Codex, Claude, or OpenCode translates the normalized server into its native launch configuration. |
| Main-process recall | Deterministic + best-effort | A non-empty redacted prompt triggers bounded search and accepted-page reads; service failure falls back to tools plus base instructions. |
| Direct durable-learning decision | Best-effort agent judgment | The model must notice a reusable learning and call `memory_propose`; no end-of-turn reflection enforces this decision. |
| Optional compatibility hook | Marker-gated + best-effort | A separately configured hook and PAT/org environment must exist, and the turn must supply an explicit note, argument, or visible `MEMORY:` line. |
| Successful turn settlement | Settlement-gated | Only a `Done` terminal event enters automatic source capture; failed, cancelled, or unsettled turns do not. |
| Digest construction and redaction | Deterministic | Jingler keeps bounded user/final-assistant prose, excludes tool/protocol data, and applies credential-shape redaction. |
| Local outbox and delivery | Best-effort | Atomic enqueue succeeds, then a daemon drain must deliver before the five-attempt/seven-day drop boundary. Capture return success means queued, not published. |
| Source authorization and org scope | Deterministic | The grant needs `propose`, the organization headers must match, and session-source identity must equal its idempotency key. |
| Durable source ingest | Deterministic | The organization Durable Object and R2 store one immutable same-ID/same-content source; conflicting content is rejected. |
| Compiler start and source validation | Workflow-gated | A compiler binding exists, the deterministic org/source instance starts, and bounded content passes identity, size, and credential checks. |
| Claim extraction and draft generation | Deterministic + workflow-gated | At least one 12–600 character line survives; lexical routing creates one to three citation-bearing drafts. There is no successful no-op. |
| Full-vault proposal lint | Deterministic + workflow-gated | Draft identity, revision, citation, and relationship rules must leave the entire candidate vault valid. The generic session-title collision currently fails here. |
| Review and publication | Workflow-gated | Default compiler sets auto-publish; review-enabled sets wait for an accept/reject event. Stale heads conflict and publication commits all set revisions together. |
| Accepted lexical/search projection | Deterministic | The Durable Object commit advances heads, events, FTS5 projection, and projected pages atomically after R2 publication artifacts exist. |
| Advisory vector projection | Best-effort + workflow-gated | Accepted publication triggers vector reconciliation; failures are swallowed and the daily drift sweep retries. It does not gate accepted memory. |
| Graph relationship extraction | Deterministic after publication | Graph reads re-derive citation, wikilink/backlink, dependency, and schema edges from accepted evidence; the current compiler emits only citations. |

## End-to-end launch and recall path

### Access and organization selection

| Gate | Classification | Confirmed behavior |
| --- | --- | --- |
| Server feature flag | Deterministic | `MEMORY_ENABLED` must be on. Disabled grant/source routes return `503`. |
| Billing and membership | Deterministic | Grants require an exact membership in an active paid organization. Missing, malformed, free, cancelled, or partially active billing metadata fails closed. |
| Role privileges | Deterministic | Members receive `read` + `propose`; admins add `review`; owners add `schema`. MCP tools and source capture are filtered by the signed privileges. |
| Desktop sign-in and selection | Deterministic | The keychain token, `memory.enabled`, and a non-empty selected organization are all required. When memory config is wholly absent and exactly one eligible org exists, `access()` enables and selects it. Explicit disable is respected; multiple orgs need a user selection. |
| Harness support | Deterministic | Claude, Codex, and OpenCode are eligible. Cursor returns no attachment because Jingler cannot launch it. |
| Grant/discovery/proxy | Best-effort | Grant mint, server discovery, and the private loopback proxy use a 1.5-second default timeout and fail open to no memory attachment. A validated attachment is cached; the main process refreshes grants and keeps upstream credentials out of harness-visible config. |

### Per-turn attachment

`AgentRunner.prompt` calls `memoryService.attachment(cli, rawOperatorText,
sessionId:chatId)` before every launch. The raw operator text is used for recall;
orchestration/persona notes are intentionally excluded from the query. A memory
attachment is composed first, ahead of operator connectors, and first-name-wins
deduplication prevents a connector from shadowing the reserved `jingler-memory`
name. Secret-bearing attachments remain in the Electron main process and are not
written to the session transcript.

The harness translations are deterministic once the attachment exists:

| Harness | Native injection |
| --- | --- |
| Codex | App-server `-c` overrides register each `mcp_servers.<name>.url`; mapped bearer values are supplied through a launch-only environment variable and excluded from Codex's shell environment. |
| Claude | The SDK receives the complete collection inline as `mcpServers`, bypassing project MCP approval files. |
| OpenCode | Jingler starts the local OpenCode server and calls its authenticated `client.mcp.add` API for every normalized remote attachment before prompting. |

The memory instructions are inserted by `composeTurnPrompt`. Ordinary prompts get
the notes before the user text; slash commands and Codex `$skill` invocations stay
first and receive the notes afterward so the harness still expands them.

### Recall gates

| Gate | Classification | Confirmed behavior |
| --- | --- | --- |
| Main-process pre-turn recall | Deterministic + best-effort | With a non-empty redacted query, Jingler calls `memory_search` with limit 3 and concurrently `memory_read`s up to three distinct accepted pages. Search/read failure falls back to the base attachment and never blocks the turn. |
| Accepted-evidence boundary | Deterministic | Only successful accepted-page reads are injected. Search snippets are never substituted when all reads fail. The block includes stable page, revision, source, and citation identifiers and bounds each body to 4,000 characters. |
| Repeated recall suppression | Deterministic | An organization/conversation-scoped fingerprint avoids reinjecting unchanged pages on later turns. An explicit empty accepted result tells the agent not to repeat the same search. |
| Agent-initiated fallback recall | Best-effort | When Jingler injects no recalled block, the prompt and MCP initialization instructions ask the model to navigate/search, then read accepted pages. Whether the model acts remains model-mediated. |

This explains why renderer transcripts undercount recall: main-process search/read
calls are injected context, not renderer `Tool` parts. The transcript audit still
found that explicit agent behavior was sparse: only one sampled Codex transcript
made memory calls, and none of the 12 sampled transcripts made a proposal.

## Historical settled-session capture path (removed)

This section records the behavior at the audit cutoff. The automatic raw-turn
capture entry point has since been removed in favor of explicit, agent-authored
proposals. Only a legacy outbox drain remains so pre-upgrade jobs are not lost.

### Settlement and digest construction

Capture was **settlement-gated**. `AgentRunner` first applied the terminal event,
patched the assistant transcript, settled context, and finalized plan verification.
Only an adapter `Done` then called `captureSettledSession`. `Failed`, cancellation,
an interrupted stream, a silent EOF, or an assistant message left `streaming: true`
did not capture.

The source contains only:

- the harness name;
- the raw operator request, clipped to 3,000 characters; and
- the final visible assistant text, clipped to 4,000 characters.

The complete digest is clipped to 8,000 characters. Tool arguments/results,
images, diagnostics, subagent-only output, protocol metadata, and request headers
are excluded. Before enqueueing, Jingler removes control characters and redacts
private-key blocks, auth/cookie/MCP-session headers, inline credentials, common
provider tokens, JWTs, secret query parameters, email addresses, and `/Users` or
`/home` usernames. This is deterministic shape-based redaction, not a semantic
privacy classifier.

### Dedupe, outbox, and organization scope

| Gate | Classification | Confirmed behavior |
| --- | --- | --- |
| Capture identity | Deterministic | `session-digest:sha256(orgId \0 sessionId \0 chatId \0 turnId)` makes replay idempotent and organization-scoped. |
| Local enqueue | Deterministic + best-effort | A semaphore-protected, atomic temp-file rename appends to `memory-capture-outbox.json`. Duplicate IDs are rejected. A failed write releases the in-process claim so a later attempt can retry. |
| Delivery | Best-effort | Capture success means “stored in the local outbox,” not “delivered” or “published.” A daemon drain uses a fresh org grant and a 1.5-second request timeout; the terminal renderer event is never held open for the network. |
| Retry | Best-effort | A failed job remains in the outbox and is retried on a later `access()` or capture-triggered drain. There is no independent timer loop. Jobs drop after five attempts, after seven days, or immediately when grant mint returns `403` because org membership is gone. |
| Next.js source route | Deterministic | The signed organization grant must include `propose`; the source must be a `session-digest:*` conversation source no larger than 8,192 characters; and `x-idempotency-key` must equal the source ID. The route forwards only its service credential, exact org scope, and request ID to the Worker. |
| Worker source ingest | Deterministic | The org Durable Object stores the immutable content in R2 and its source record in serialized org state. Same ID + same content is idempotent; same ID + different content is `409`. Retrieval telemetry is aggregate-only. |
| Compiler start | Workflow-gated | A successful source response starts or reuses one deterministic org/source compiler instance when the binding exists. A missing compiler binding leaves a stored source without compilation and without a returned workflow handle. |

Automatic capture therefore protects against an agent failing to propose, but it
does not prove memory creation: delivery, compilation, lint, publication, and graph
relationships remain separate gates.

## Direct proposals and optional post-turn hooks

### Always-injected instructions versus the optional skill

The MCP server's compact initialization instructions say “when durable knowledge
emerges” call `memory_propose`, retain the handle, and poll
`memory_workflow_status`. Jingler's richer per-turn prompt adds privacy and accepted
evidence rules but gives proposal judgment only one broad phrase: “capture what's
worth keeping.” It contains no examples, no durable-versus-ephemeral rubric, no
instruction to reflect before ending the turn, and no explicit proactive trigger.

The distributable skill does contain that missing policy: decisions, preferences,
gotchas, connections, and hard-won findings should be proposed by default, while
trivia, documented facts, ephemeral paths, and one-off values should be skipped.
However, the AgentRunner does not install or activate the skill. It attaches the
MCP tools and `memoryPrompt()` directly. Natural proposal initiation is therefore a
**best-effort agent-judgment gate** under materially thinner instructions than the
skill advertises.

### Direct `memory_propose` routing

| Request | Classification | Actual route |
| --- | --- | --- |
| `baseRevisionId: "new"` | Best-effort + workflow-gated | The server hashes grant subject + page ID + base + Markdown into a stable manual `source:proposal-*`, then uses the same compiler pipeline as session capture. The requested page ID is source metadata; the compiler chooses the accepted page identity. A compiler handle is returned and can be polled. |
| Existing accepted revision | Best-effort + workflow-gated (direct review, no Cloudflare Workflow) | The server creates a server-ID-derived, idempotent explicit proposal directly against the accepted head. Full-vault citation lint runs, but no compiler Workflow is created and no workflow handle is returned. The proposal remains `open` until a `review`-privileged actor approves or rejects it. The deployment's default compiler auto-publish policy does not apply to this route. |

The second behavior is a policy mismatch: “publishing is auto-accept by default” is
true for compiler proposal sets but not for direct updates to existing pages.

### Hook behavior by harness

The repository supplies documented configurations; Jingler does not register these
hooks itself.

| Harness | Recall hook | Persist hook | Creation gate |
| --- | --- | --- | --- |
| Claude | Optional `UserPromptSubmit` runs `recall.sh`, searches up to five hits, reads up to three accepted pages, and prints injected context. AgentRunner already provides its own deterministic recall. | Optional `Stop` runs `persist.sh`. | Marker-gated and best-effort. |
| Codex | No context-injecting native pre-turn hook; the documentation calls recall model-mediated. AgentRunner now independently provides deterministic recall, so this documentation is stale for Jingler-launched Codex. | Optional `notify` runs `persist.sh` and scans `last-assistant-message`. | Marker-gated and best-effort. |

`persist.sh` uses first-match precedence: non-empty `JINGLER_MEMORY_NOTE`, its first
non-JSON CLI argument, then up to five case-insensitive `MEMORY:` lines from the
assistant output/transcript. No candidate makes no request. The scripts also require
`JINGLER_MEMORY_URL`, `JINGLER_MEMORY_TOKEN`, and `JINGLER_MEMORY_ORG`. Jingler stores
its login token in the keychain and supplies a short-lived loopback bearer under a
different launch-only environment name; it does not populate the hook's PAT/org
variables. The hook is therefore inactive unless the user configures both the
harness hook and credentials separately.

This marker policy is unlikely to occur naturally: neither the injected prompt nor
MCP instructions ask for `MEMORY:`, and a marker in the assistant's final message is
visible to the user while the injected prompt says not to announce or narrate memory
use. The hook sends each selected note as a new proposal but redirects the entire MCP
response to `/dev/null`; it neither retains nor polls the compiler handle. Its timing
is deterministic only after the optional setup and marker have both succeeded.

## Compiler, review, publication, indexing, and graph

### Compilation gates

1. **Workflow-gated source validation.** The source identity must remain stable,
   content must be 1–32,000 characters, and the shared credential-shape detector
   must find nothing. A redacted session digest is at most 8,000 characters, so the
   size limit normally matters more for manual sources.
2. **Deterministic claim extraction.** Headings are removed; newline/sentence splits
   of 12–600 characters are deduplicated and capped at 12. Zero claims errors the
   Workflow. There is no durability scoring and no successful “nothing to remember”
   result. Digest section labels themselves pass the length gate.
3. **Deterministic candidate context.** Each claim queries the org FTS projection;
   candidate IDs are bounded, schema pages are separated, and existing pages are
   ranked only by lexical overlap between claims and page identity fields (ID, path,
   title, aliases, tags), not page body semantics.
4. **Deterministic generation.** Production constructs a strong compiler prompt,
   including the rule to treat sources as evidence and edit only supplied pages,
   but `MemoryCompilerWorkflow` instantiates `DeterministicCompilerModel` directly.
   That model never consumes `context.prompt`; no configured LLM/compiler model is
   called. The prompt is currently documentation/test context, not an enforcement
   mechanism.
5. **Bounded drafts.** At most three pages are generated. Lexically matched claims
   append a `## Compiled learnings` section to existing pages. Any unmatched claim
   creates one new `compiled-learning` page whose title is copied from the source,
   whose body is a list of every unmatched claim, and whose `relationships` array is
   empty.
6. **Full-vault proposal lint.** A proposal set must contain 1–8 unique page edits,
   cite the compiler source, preserve page/path identity, advance an existing head
   by exactly one or use revision 1 for a new page, and leave the whole candidate
   vault valid with required citations and resolvable identities/relationships.
   Stale heads conflict. Same set/content retries are idempotent.

The production suppression occurs at gate 6. The generic session source title is
copied into every unmatched new page. Once one such page was accepted, later pages
with the same title failed duplicate-identity lint during step
`05-lint-and-persist-proposal`. `MemoryLintError` is not converted to a typed
`MemoryVaultError`, so the public Worker boundary returns only
`{code: "internal_error", error: "memory service failed"}`. Cloudflare retries the
permanent validation failure six times before marking the Workflow errored. The
hosted audit observed exactly that step pattern for the failed session cohort.

### Review and publication

Compiler proposal sets auto-publish by default. Only the exact environment value
`MEMORY_REQUIRE_REVIEW=true` parks factual changes on a durable review event for up
to 30 days. A configured `canonical-markdown` mechanical change can bypass review
only when a semantic comparison proves it changed no accepted content beyond
revision/citation mechanics. Review rejection, stale-head conflict, and acceptance
are terminal Workflow results. The status endpoint reports queued/running platform
state, synthesizes `pending_review` only once the Workflow is genuinely waiting,
and otherwise returns the Workflow output.

Publication writes content-addressed Markdown revisions and a multi-page
publication commit to organization-prefixed R2, then advances serialized heads,
events, proposals, FTS5/search projection, and projected pages in one Durable Object
commit. R2 is the recovery source of truth; a rebuild ignores incomplete multi-page
publications and reconstructs accepted heads and lexical search from complete
records. R2 history snapshots are written after the DO commit.

Accepted publication also best-effort starts an org-scoped vector-ingest Workflow.
Failure is swallowed because vectors are advisory; a daily cron discovers R2 orgs
and reconciles drift. The suggestion endpoint degrades to deterministic lexical
relatedness when OpenAI or turbopuffer is absent or fails. None of this controls
accepted publication, lexical search, graph output, or export hashes.

### Graph relationship extraction

The graph endpoint does not read a separately persisted graph index. It loads
accepted pages plus repository sources and derives nodes and edges:

- each inline citation reference becomes a page-to-source `citation` edge;
- each resolvable body wikilink becomes a forward `wikilink` and reverse
  `backlink` edge;
- frontmatter `dependency` entries become page-to-page edges; and
- frontmatter schema relationships become page-to-schema edges.

The bounded view tolerates broken links by skipping them and reporting health;
strict export derivation rejects unresolved evidence. Vector suggestions and topic
clusters are hints, not graph relationships. Because the compiler only adds inline
citations and always emits empty relationships with no wikilinks, disconnected
compiled pages are expected behavior, not evidence of failed graph projection.
Scheduled lint reports orphaned pages but is read-only and cannot add relationships.

## Intended-versus-actual mismatches and likely suppression mechanisms

| Priority | Mismatch | Observable effect |
| --- | --- | --- |
| 1 | Natural proposal policy is much weaker in the always-injected prompt than in the optional skill, and there is no end-of-turn reflection. | The sampled settled cohort had 58 conservative durable candidates but zero explicit proposals or workflow polls. Nineteen candidates arose after memory was demonstrably exposed. |
| 2 | The generic settled-session title becomes every unmatched new page title. | Hosted state had one published session workflow, 160 errored session workflows, and one session workflow still running at cut-off. A representative failure exhausted retries at step 05. Automatic capture did not compensate for missed direct proposals. |
| 3 | Persist hooks are optional, credentialed separately, marker-gated, and conflict with silent-use wording. | A normal Jingler launch does not deterministically reflect on or submit a selected durable note. Even a successful hook submission is unobserved because its handle is discarded. |
| 4 | Claim extraction measures sentence shape, not durability, and has no no-op result. | Structural labels and progress narration can publish as memory; the one accepted session page contains empty section labels and 12 transcript-derived lines. Broad low-quality compilation also makes identity collisions more likely. |
| 5 | The compiler prompt is built but unused by the production deterministic model. | Prompt rules cannot improve selection, merge semantics, title choice, or relationship generation. |
| 6 | New-page proposals auto-publish through the compiler, while direct existing-page proposals remain open. | Agents following the same `memory_propose` instruction receive different settlement semantics; existing updates have no Workflow handle to poll and require an admin review action. |
| 7 | The deterministic compiler never emits page relationships or wikilinks. | Hosted accepted pages have citation provenance but zero durable page-to-page edges; all are knowledge-graph orphans. |
| 8 | Several boundaries deliberately fail open or redact typed causes. | Attachment/capture failures do not block work, capture success only means local enqueue, hook HTTP results are discarded, and duplicate lint reached agents/operations only as a generic internal error. |

The first two mechanisms are independently sufficient to explain the observed low
memory creation: agents rarely initiate a proposal, and the fallback automatic path
fails after capture. Tool unavailability remains important for older transcripts,
but it is not the full current explanation because recent sessions with attached
memory also missed proposals.

## Implementation evidence index

| Segment | Primary implementation evidence |
| --- | --- |
| Selection, grant, attachment, recall, digest, and outbox | `packages/cli-adapters/src/memory.ts` |
| Per-turn launch and `Done` settlement boundary | `packages/cli-adapters/src/agent-runner.ts` |
| Silent proposal/recall policy | `packages/cli-adapters/src/memory-prompt.ts` |
| Codex, Claude, and OpenCode MCP translations | `packages/cli-adapters/src/mcp-config.ts`, `claude-adapter.ts`, `codex-app-server-run.ts`, and `opencode-adapter.ts` |
| Grant-filtered MCP tools and direct proposal routing | `apps/server/src/mcp-memory.ts` |
| Settled-source authorization and forwarding | `apps/server/src/memory-sources.ts` |
| Source ingest, Workflow creation/status, and vector trigger | `apps/memory-worker/src/api.ts` |
| Claim extraction, deterministic drafts, review, and auto-publication | `apps/memory-worker/src/workflows/compiler.ts` |
| Full-vault proposal validation | `apps/memory-worker/src/proposals.ts` and `packages/memory/src/lint.ts` |
| R2 artifacts, publication commit, FTS state, and recovery | `apps/memory-worker/src/r2-store.ts` and `team-vault.ts` |
| Accepted-evidence graph derivation | `packages/memory/src/graph.ts` and `apps/memory-worker/src/graph.ts` |
| Optional compatibility hooks | `skills/jingler-team-memory/hooks/recall.sh`, `persist.sh`, and `hooks/config/*` |

## Focused verification

No test or production state was modified. The focused commands exercised attachment,
prompt composition, settled capture, hook marker behavior, proposal routing,
compiler review/publication, R2 recovery, vector reconciliation, and graph evidence.

| Command | Result |
| --- | --- |
| `pnpm exec vitest run packages/cli-adapters/src/turn-prompt.test.ts packages/cli-adapters/src/mcp-inject.test.ts packages/cli-adapters/src/memory.test.ts` | `Test Files 3 passed (3)`; `Tests 38 passed (38)`. |
| `pnpm exec vitest run packages/cli-adapters/src/agent-runner.test.ts -t "AgentRunner team memory"` with loopback binding permitted | `Test Files 1 passed (1)`; `Tests 4 passed, 73 skipped`. |
| `env -u CODEX_SANDBOX_NETWORK_DISABLED pnpm exec vitest run packages/cli-adapters/src/memory-mcp-proxy.test.ts` with loopback binding permitted | `Test Files 1 passed (1)`; `Tests 4 passed (4)`. |
| `pnpm --filter @jingler/server test -- src/mcp-memory.test.ts src/memory-hooks.test.ts` | The package script ran the complete server unit suite: `Test Files 12 passed (12)`; `Tests 102 passed (102)`, including all 8 hook and 29 MCP tests. |
| `pnpm exec vitest run apps/memory-worker/src/workflows/compiler.test.ts apps/memory-worker/src/api.test.ts apps/memory-worker/src/team-vault.test.ts apps/memory-worker/src/graph.test.ts apps/memory-worker/src/workflows/vector-ingest.test.ts` | `Test Files 5 passed (5)`; `Tests 47 passed (47)`. |
| `pnpm exec vitest run apps/memory-worker/src/team-vault.test.ts -t "accepts exactly one concurrent proposal and reports the other as a conflict\|bounds in-memory retrieval metrics to the newest RETRIEVAL_RETENTION rows"` | Isolated follow-up: `Test Files 1 passed (1)`; `Tests 2 passed, 12 skipped`. |

One broader package-script invocation is preserved as a load-sensitive test-run
failure: `pnpm --filter @jingler/memory-worker test -- ...` ignored the supplied
file selectors and ran all 11 Worker files concurrently. It reported `Test Files
1 failed, 10 passed` and `Tests 2 failed, 81 passed`; both failures were five-second
timeouts in `TeamVault > accepts exactly one concurrent proposal and reports the
other as a conflict` and `TeamVault > bounds in-memory retrieval metrics to the
newest RETRIEVAL_RETENTION rows`. Running those exact two tests alone immediately
afterward produced `Test Files 1 passed (1)` and `Tests 2 passed, 12 skipped`; the
properly targeted five-file command above then passed all 47 tests without a timeout
override. The audited behavior is green, while the full-suite default timeout is a
separate load-sensitivity signal.

The suites do not contain the production sequence “accept one generic-title session
page, then compile a second generic-title session source.” Compiler and publication
tests therefore pass while hosted compilation fails consistently. This is a specific
coverage gap, not a contradiction between the test and production evidence.

## Conclusion

The integration has strong deterministic recall, credential isolation, redaction,
organization scoping, idempotency, and recoverable storage. Those controls are not
the reason memory creation is sparse. The creation policy relies on model judgment
without the skill's useful rubric, the optional deterministic-timing hooks almost
never receive their marker naturally, and the automatic fallback currently fails at
full-vault lint after the first generic session page. Even successful compilation
cannot create a connected knowledge graph because its deterministic output contains
no page relationships. These are separable gates and should be measured separately:
explicit agent proposal, settled source capture, compiler settlement, accepted
publication, and page-to-page relationship creation are not interchangeable success
signals.
