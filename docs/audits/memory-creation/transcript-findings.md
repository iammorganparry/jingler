# Recent-session memory creation audit

Audit snapshot: `2026-08-06T12:02:00Z`

Sampling window: `[2026-07-28T00:00:00Z, 2026-08-06T00:00:00Z)`

## Executive finding

The sampled Jingler sessions contained substantial reusable knowledge, but agents
did not explicitly persist it. Across 12 settled transcripts (6 Codex and 6
Claude), a conservative manual rubric found **58 durable-learning candidates**:
29 per harness. The renderer-visible traces contain **11 `memory_search` calls,
7 `memory_navigation` calls, and zero `memory_read`, `memory_propose`, or
`memory_workflow_status` calls**. All explicit memory calls came from one Codex
session; its 11 searches completed successfully but returned no accepted match.

This does not mean automatic memory was wholly absent. Native harness logs prove
that Jingler injected its memory prompt or recalled-memory block into four sampled
sessions, and Jingler separately submits a redacted source after a settled turn.
Neither mechanism is an explicit agent proposal: injected recall is not a
renderer `Tool` part, and settled-session source capture does not call
`memory_propose`. The audit therefore reports those paths separately.

The 58 missing explicit proposals break down as:

| Preliminary category | Candidates | Meaning in this audit |
| --- | ---: | --- |
| Agent judgment | 19 | The learning arose after Jingler memory was demonstrably exposed, but the agent did not propose it. |
| Tool availability | 38 | The native turn has no Jingler memory attachment/tool surface; most predate rollout. |
| Capture behavior | 1 | Prose claimed a finding was stored, but no proposal trace exists. |
| Integration | 0 | No sampled turn showed an attached tool failing to reach Jingler. |
| Workflow | 0 | No proposal was submitted, so no compiler/review workflow could fail or go unpolled. |

No sampled example is assigned to authentication, interruption, or settlement.
Credential/authentication failures were not observed. One otherwise recent Codex
transcript ended with `streaming: true` and was excluded before sampling.

## Authoritative stores and formats

Jingler's audit source is its own renderer-visible transcript, not a harness's
private continuity log.

| Store | Format and role | Snapshot observation |
| --- | --- | --- |
| `~/jingler/sessions.json` | `Session[]`; maps session/chat IDs to harness, model, worktree, resume ID, and persisted status. | 113 sessions: 40 Codex, 73 Claude, 0 OpenCode; 115 chats. |
| `~/jingler/transcripts/<chatId>.json` | Authoritative `Message[]` rendered by Jingler. Each message has `createdAt`, `role`, `streaming`, and typed parts such as `Text` and `Tool`. | 137 JSON files. All 115 current chats resolve: 49 chat-keyed and 66 legacy first-chat files still keyed by session ID. There are 22 unreferenced historical JSON files, 31 disposable `.index` files, and one `.tmp`. |
| `~/.codex/sessions/YYYY/MM/DD/rollout-…<resumeId>.jsonl` | Codex-native continuity log. Used here only to confirm Jingler prompt/recall injection. | 478 JSONL files. Not the renderer transcript. |
| `~/.claude/projects/<cwd-slug>/<resumeId>.jsonl` | Claude-native continuity log and the recovery copy used by `transcript-backfill.ts`. | 1,904 JSONL files. Not the primary audit source. |
| `~/.local/share/opencode/opencode.db` | OpenCode-native SQLite continuity store (`session`, `message`, `part`, and related tables). | 24 native sessions, 61 messages, 170 parts; no current Jingler OpenCode session to map into the cohort. |
| `~/jingler/memory-capture-outbox.json` | Retry queue for automatic redacted settled-turn source capture. | One pending job from outside the sampling window at snapshot time. Delivered jobs are removed, so this file cannot prove historical cohort delivery. |

Current mapped-transcript inventory at the snapshot:

| Harness | Chats | Messages | User turns | Tool parts | Transcript storage | Persisted/last-message state |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Codex | 41 | 1,384 | 692 | 17,910 | 31 chat-keyed, 10 legacy | all 41 persisted `idle`; 37 end `assistant/false`, 3 `assistant/true`, 1 empty |
| Claude | 74 | 3,094 | 1,557 | 32,263 | 18 chat-keyed, 56 legacy | 73 `idle`, 1 `needs-input`; 68 end `assistant/false`, 4 `assistant/true`, 2 end with a user message |
| OpenCode | 0 | 0 | 0 | 0 | none mapped | no Jingler settlement record |

`chat.updatedAt` is not a reliable turn clock: resumed chats can continue writing
messages without advancing it. This audit therefore uses the final transcript
message's `createdAt` as `settledAt`.

## Reproducible cohort

The selection unit is one mapped chat transcript.

1. Resolve `transcripts/<encoded chatId>.json`; for the first chat only, fall
   back to the legacy `transcripts/<encoded sessionId>.json`.
2. Keep transcripts whose final `Message.createdAt` is inside the UTC window.
3. Require persisted status `idle` or `needs-input`, a final assistant message,
   and `streaming: false`.
4. Per harness, rank by user-turn count descending, then Tool-part count
   descending, then chat ID ascending. Select the first four as the long cohort.
5. From the remainder, rank by user-turn count ascending, final timestamp
   descending, then chat ID ascending. Select two as the comparison cohort.

The window contained 25 eligible Codex transcripts, 8 eligible Claude
transcripts, and no mapped OpenCode transcript. The deterministic rule selected:

| Cohort | Harness | Session / transcript | Settled at (UTC) | User turns | Tool parts | Durable candidates |
| --- | --- | --- | --- | ---: | ---: | ---: |
| Long | Codex | `s_signals-widget-msd6b4q7` / `c_s_signals-widget-msd6b4q7_1.json` | 2026-08-04 17:20:58 | 64 | 1,279 | 10 |
| Long | Codex | `s_plan-mode-improvements-ms501sel` / `c_s_plan-mode-improvements-ms501sel_1.json` | 2026-07-29 12:18:22 | 43 | 750 | 6 |
| Long | Codex | `s_nimble-einstein` / `c_s_nimble-einstein_1.json` | 2026-07-31 12:29:48 | 42 | 771 | 4 |
| Long | Codex | `s_gh-rework-msf0gzo0` / `c_s_gh-rework-msf0gzo0_1.json` | 2026-08-05 21:02:32 | 37 | 2,349 | 7 |
| Comparison | Codex | `s_fix-ss-attachment-to-orchestrator-msfnvoc4` / `c_s_fix-ss-attachment-to-orchestrator-msfnvoc4_1.json` | 2026-08-05 06:03:31 | 2 | 55 | 1 |
| Comparison | Codex | `s_open-code-in-app-ms6bwzl7` / `c_s_open-code-in-app-ms6bwzl7_1.json` | 2026-07-29 17:13:00 | 2 | 30 | 1 |
| Long | Claude | `s_onboarding-performance-msd6ox22` / `c_s_onboarding-performance-msd6ox22_1.json` | 2026-08-04 14:38:03 | 46 | 389 | 8 |
| Long | Claude | `s_signals-jarvis-ms4fdb0b` / `c_s_signals-jarvis-ms4fdb0b_1.json` | 2026-07-29 07:32:59 | 40 | 551 | 5 |
| Long | Claude | `s_feat-signals-account-first-signals-recency-roster-evidence-backed-scoring-identity-attribution-1629_ms1hgt2b` / matching `_1.json` | 2026-07-28 08:50:21 | 33 | 632 | 7 |
| Long | Claude | `s_branding-ms48gne5` / `c_s_branding-ms48gne5_1.json` | 2026-07-28 08:26:28 | 29 | 476 | 4 |
| Comparison | Claude | `s_jingler-main-ms7yn3yj` / `c_s_jingler-main-ms7yn3yj_mscunrl0_373.json` | 2026-08-03 07:26:21 | 2 | 22 | 1 |
| Comparison | Claude | `s_ui-adjustments-ms4loe59` / `c_s_ui-adjustments-ms4loe59_1.json` | 2026-07-28 14:50:30 | 11 | 289 | 4 |

The cohort totals 351 user turns, 702 messages, and 7,593 Tool parts. “Long” is a
ranked cohort label, not a universal threshold; this avoids inventing a cutoff
that would exclude Claude when only eight settled transcripts were eligible.

## Durable-learning rubric

A candidate must satisfy all of these:

- It is one standalone fact, decision, preference, gotcha, or hard-won finding.
- A future agent could reuse it beyond the immediate command or temporary state.
- It is grounded by code, a test, a query, a benchmark, an observed failure, or
  an explicit user decision in the transcript.
- It can be written without credentials, personal data, or machine-local trivia.
- It is not merely a progress report, commit/PR identifier, transient URL, raw
  tool output, or a claim corrected later in the same transcript.

Counts are conservative lower bounds. Examples that passed include evidence-set
deduplication semantics, session-scoped relay persistence, a TypeScript binary
shadowing failure, browser/OAuth cookie boundaries, renderer-state reconciliation,
and model/schema compatibility findings. Credential-bearing setup turns were
excluded rather than sanitized into candidates.

| Harness | Long-session candidates | Comparison candidates | Total |
| --- | ---: | ---: | ---: |
| Codex | 27 | 2 | 29 |
| Claude | 24 | 5 | 29 |
| OpenCode | 0 | 0 | 0 |
| **Total** | **51** | **7** | **58** |

## Explicit memory-tool traces

Counts below come only from renderer-visible `Tool` parts, after normalizing the
tool name. They do not include Jingler's main-process recall or capture.

| Harness | Transcripts | `memory_search` | `memory_navigation` | `memory_read` | `memory_propose` | `memory_workflow_status` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Codex | 6 | 11 | 7 | 0 | 0 | 0 |
| Claude | 6 | 0 | 0 | 0 | 0 | 0 |
| OpenCode | 0 | 0 | 0 | 0 | 0 | 0 |

Only `c_s_signals-widget-msd6b4q7_1.json` contains explicit memory tools. Its 11
searches have successful tool status and empty accepted-result sets, explaining
the zero accepted-page reads. The agent still had ten new durable candidates it
could have proposed.

Native-log markers add availability context without changing those counts:

- Signals Widget contains the Jingler memory prompt and explicit successful tools.
- GitHub Rework and Screenshot Attachment contain the Jingler prompt plus
  automatically injected recalled-memory blocks, but no explicit memory call.
- Onboarding Performance first receives the Jingler memory prompt for its final
  two turns; earlier findings in that transcript are classified unavailable.
- The other sampled turn spans have no Jingler memory attachment. A similarly
  named third-party/local hook is not counted as Jingler memory.

## Representative missed-memory traces

Every row below points to a transcript that passed the settlement filter. Excerpts
are shortened and contain no credentials or credential-shaped values.

| Transcript evidence | Durable learning | Category | Why it is missed |
| --- | --- | --- | --- |
| `c_s_signals-widget-msd6b4q7_1.json`, turn 24: “dedup identity is the evidence set, not a time bucket” | Same proof activities are duplicates; different evidence may legitimately retrigger the same signal. | Agent judgment | Explicit memory search was usable in this session; no proposal followed the hard-won database diagnosis. |
| `c_s_gh-rework-msf0gzo0_1.json`, turns 26–29: “Durable Objects handle offline replay” and “a durable object maps to a session” | Relay persistence must be session-scoped so queued feedback reaches the correct agent; Workflows own retry/orchestration. | Agent judgment | Jingler prompt and automatic recall were injected; proposal count is zero. |
| `c_s_fix-ss-attachment-to-orchestrator-msfnvoc4_1.json`, turn 1: accepted screenshots were deleted before Codex asynchronously read them | Steered screenshot files must outlive asynchronous Codex ingestion. | Agent judgment | Memory prompt/recall was injected in the two-turn session; no proposal exists. |
| `c_s_onboarding-performance-msd6ox22_1.json`, turn 46: connector logos use a multi-provider fallback and reset their cursor on prop change | Image fallback state must reset when the connector identity changes or stale/blank logos survive. | Agent judgment | The late Jingler prompt was present for this turn; no proposal exists. |
| `c_s_onboarding-performance-msd6ox22_1.json`, turns 39–42: a Vertex-routed model rejected the complex output schema and silently produced an empty profile | Model/provider structured-output compatibility can fail only on large schemas; direct Exa structured answers avoided the failure. | Tool availability | This finding predates the first Jingler memory attachment in the native session. |
| `c_s_feat-signals-account-first-signals-recency-roster-evidence-backed-scoring-identity-attribution-1629_ms1hgt2b_1.json`, turn 13: workspace `tsc` resolved to TypeScript 6 while the direct TypeScript binary was 7 | An aliased dependency can win the workspace `.bin/tsc` slot and defeat an intended compiler upgrade. | Tool availability | The turn has no Jingler memory attachment/tool surface. |
| `c_s_nimble-einstein_1.json`, turns 31–34: embedded Picker auth could not inherit the user's external-browser cookies | Keep Google consent/Picker in the default browser unless the full flow shares one Electron session; OAuth tokens cannot become browser cookies. | Tool availability | The settled session predates Jingler memory rollout. |
| `c_s_signals-jarvis-ms4fdb0b_1.json`, turn 22: assistant said the loop finding was “stored to memory” | PostHog showed 18 identical account-activity reads; the agent needed an idempotent read cache/no-progress guard. | Capture behavior | No `memory_propose` exists and the native session has no Jingler memory tool attachment. Conversational wording is not persistence evidence. |

All other durable candidates were classified with the same turn-level rule. The
aggregate missed-explicit-persistence rate is **58/58 (100%)**: 29/29 for Codex
and 29/29 for Claude. This is not a claim that automatic settled-session capture
lost all 58; historical delivery cannot be reconstructed from the drained outbox.

## Automatic recall and historical capture are not proposals

Jingler's pre-turn path performs bounded recall in the main process and may inject
`<recalled-memories>`. Those calls are intentionally absent from the visible
agent tool trace. At the audit cutoff, a successful settled turn wrote a redacted
conversation digest to an outbox and submitted it as a source. That capture entry
point has since been removed; the remaining drain exists only for pre-upgrade
outbox files.

An explicit agent proposal is different: it must produce a renderer-visible
`memory_propose` Tool part and, when a workflow handle is returned, one or more
`memory_workflow_status` calls until settlement. The cohort contains neither.
Therefore assistant phrases such as “memories stored” cannot be credited as an
explicit proposal, and automatic source capture cannot be reported as one.

## Limitations

- No mapped OpenCode session existed, so the report can quantify absence but
  cannot compare OpenCode agent judgment. Its native SQLite rows are not enough
  to prove a Jingler-launched, settled transcript.
- Unreferenced historical transcript files were excluded because their current
  harness and settlement metadata cannot be traced through `sessions.json`.
- Native logs were searched only for Jingler attachment/tool markers. Content
  classification used the redacted renderer transcript, the product's source of
  truth for what the user saw.
- Delivered automatic-capture jobs disappear from the outbox; backend source
  records would be required for historical delivery-rate measurement.
- The rubric is manual and intentionally conservative. Exact candidate counts are
  review judgments, while turn, tool, harness, and settlement counts are direct
  observations.

## Conclusion

The cohort supports a narrow but strong diagnosis: when tools were absent, useful
knowledge accumulated without an explicit persistence path; once memory was
injected, recall sometimes happened but proposal behavior still did not. The
largest measured gap is therefore not workflow polling or proposal settlement—it
is initiating `memory_propose` at all. Automatic source capture may mitigate
loss, but it should be evaluated as a separate capture pipeline rather than as
evidence of natural agent memory creation.
