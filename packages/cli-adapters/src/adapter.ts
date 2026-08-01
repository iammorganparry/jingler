import type {
  Attachment,
  CliKind,
  ModelOption,
  PermissionMode,
  Plan,
  QuestionAnswer,
  QuestionRequest,
  ReasoningEffort,
  StreamEvent,
  WorkerRoutingConfig
} from "@jingler/core"
import { CliExecError } from "@jingler/core"
import { Context, Data, Effect, Layer } from "effect"

/** Installed provider/model routes a planning turn may assign to workers. */
export interface OrchestrationRoute {
  readonly cli: CliKind
  readonly models: ReadonlyArray<ModelOption>
}

/**
 * A remote MCP attachment ready for a harness launch.
 *
 * Main-process only: headers may contain bearer credentials. AgentRunner builds
 * this source-neutral shape immediately before a run; adapters consume it
 * in-memory and never persist or expose it through RPC.
 */
export interface RemoteMcpServer {
  readonly name: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /**
   * Optional header-to-environment-name map for harnesses that can resolve
   * secret headers from their launch environment instead of exposing values in
   * command-line arguments.
   */
  readonly headerEnvironment?: Readonly<Record<string, string>>
}

/** Parameters for starting a new agent turn against a CLI. */
export interface SessionSpec {
  readonly cli: CliKind
  readonly repo: string
  readonly branch: string
  readonly cwd: string
  readonly prompt: string
  /** Images the operator attached as context for this turn (empty when none). */
  readonly images: ReadonlyArray<Attachment>
  /** Resolved path to the harness binary, or null when it isn't installed. */
  readonly binPath: string | null
  /** The session's HITL permission mode (drives the harness's permission mode). */
  readonly mode: PermissionMode
  /** The model id to run, or null to use the harness default. */
  readonly model: string | null
  /** The configured canonical PRD structure for a native plan-mode turn. */
  readonly planTemplate?: string
  /**
   * Present only for an orchestrator turn. Native and reply-channel planners
   * receive this same catalogue and assignment grammar, so choosing a smaller
   * model cannot silently downgrade the plan procedure.
   */
  readonly orchestrationRoutes?: ReadonlyArray<OrchestrationRoute>
  /** True after this orchestrator has crossed its one plan-approval gate. */
  readonly orchestrationPlanApproved?: boolean
  /** Effective concrete worker routes by component complexity. */
  readonly workerRouting?: WorkerRoutingConfig
  /** Whether provider thinking is enabled; absent leaves its default untouched. */
  readonly thinkingEnabled?: boolean
  /** Provider-native effort; absent leaves the harness default untouched. */
  readonly reasoningEffort?: ReasoningEffort
  /**
   * The harness session id to RESUME from (persisted across app restarts), or
   * null for a fresh conversation. The adapter prefers its live in-memory id and
   * falls back to this, so "continue" reloads the full conversation even after a
   * restart cleared the in-memory resume map.
   */
  readonly resumeId: string | null
  /**
   * Force a brand-new harness conversation, ignoring the adapter's in-memory
   * resume map entirely (and not writing to it).
   *
   * `resumeId: null` is NOT enough on its own: the adapter prefers its live map
   * over the spec, so a repeated run under the same key silently resumes the
   * previous one. A one-shot run that must be a pure function of its prompt —
   * the adversarial reviewer — sets this.
   */
  readonly fresh?: boolean
  /**
   * This run must not mutate anything — no edits, no shell commands. Enforced by
   * the HARNESS, and each adapter says it in its own vocabulary (Claude: refuse
   * the write tools; Codex: a read-only sandbox).
   *
   * `ctx.canUseTool` is not sufficient on its own, in two independent ways:
   *  - it is a denylist over tool NAMES we recognise (`toPermissionRequest`
   *    returns null → allowed ungated), so a write-capable tool we don't know
   *    about is silently permitted; and
   *  - the Codex adapter never calls it at all (its exec model has no per-tool
   *    callback), so for Codex the callback is not a control surface whatsoever.
   *
   * Hence intent lives here rather than a list of Claude's tool names: a spec
   * field only one adapter understands is a guarantee only one adapter keeps.
   */
  /**
   * Every remote MCP server attached to this run, regardless of where it came
   * from. AgentRunner joins configured and internal sources once, immediately
   * before launch, and each adapter translates this collection into its native
   * vocabulary. It is optional for direct adapter callers; AgentRunner always
   * supplies the collection (including an empty one).
   *
   * This is secret-bearing launch data. It stays in the Electron main process,
   * is consumed in-memory by the adapter, and must never be persisted or sent
   * through RPC.
   */
  readonly remoteMcpServers?: ReadonlyArray<RemoteMcpServer>

  readonly readOnly?: boolean
  /**
   * This agent runs with nobody watching, so apply the protections that implies.
   *
   * Two mechanisms, deliberately kept separate because they fail differently:
   *
   *  1. **File-tool confinement to `cwd`** (`confinement.ts`). Read tools are
   *     never gated — `toPermissionRequest` returns null for them — so without
   *     this an agent reads anything on disk. A planning proposer was observed
   *     doing exactly that, pulling 403 lines of an unrelated private repository
   *     into its context. Pure, and works on every platform.
   *  2. **A credential denylist sandbox** (`sandbox.ts`). The check above cannot
   *     see a shell, and a plan step needs Bash to build and test, so `cat
   *     ~/.ssh/id_rsa` walked straight through it. The sandbox blocks that at the
   *     OS level — but it needs platform support and degrades silently when
   *     absent, which is why (1) is kept rather than replaced.
   *
   * NEITHER IS CONFINEMENT TO THE WORKTREE, and the gap is measured rather than
   * assumed: `denyRead` is absolute with no carve-out, so denying `~` also denies
   * a worktree under `~`. A step that cannot read its own repository is useless.
   * Anything outside the denylist and outside the file tools remains reachable.
   *
   * Deliberately NOT set for the operator's own session: they are watching, and a
   * coding agent that cannot read a sibling repo on request is less useful.
   */
  readonly unattended?: boolean
}

/** What the agent is asking permission to do, surfaced before it acts. */
export interface PermissionRequest {
  readonly kind: "command" | "edit"
  /** Tool name, e.g. "Edit" or "Bash". */
  readonly tool: string
  readonly target: string | null
  /** The shell command awaiting approval, when `kind === "command"`. */
  readonly command: string | null
}

export type PermissionDecision = "allow" | "deny"

/**
 * A permission resolver the adapter calls before any gated action. The
 * `AgentRunner` supplies one that applies the session's HITL mode/allowlist and,
 * when it must pause, emits an approval gate and awaits the operator. Mirrors the
 * real `claude -p` `canUseTool` callback, keeping the adapter harness-agnostic.
 */
export type CanUseTool = (req: PermissionRequest) => Effect.Effect<PermissionDecision>

/**
 * Present a group of structured questions to the user and await the answers
 * (mirrors the SDK's AskUserQuestion tool). The `AgentRunner` supplies one that
 * emits a `QuestionRequested` event and parks until the user submits.
 */
export type AskQuestion = (
  request: QuestionRequest
) => Effect.Effect<ReadonlyArray<QuestionAnswer>>

/**
 * The operator's verdict on a proposed plan (mirrors ExitPlanMode's approval):
 * - `Approve` — start execution under `mode` (the session's restored exec mode),
 * - `Delegate` — the plan was approved, but Jingler's provider-neutral
 *   orchestrator owns execution rather than this planning harness,
 * - `Revise` — keep planning, addressing `feedback` (bundled step comments),
 * - `Reject` — abandon the plan (e.g. the run was stopped).
 */
export type PlanDecision = Data.TaggedEnum<{
  Approve: { readonly mode: PermissionMode; readonly plan?: Plan }
  Delegate: {}
  Revise: { readonly feedback: string }
  Reject: {}
}>
export const PlanDecision = Data.taggedEnum<PlanDecision>()

/**
 * Present a structured plan (from ExitPlanMode) and await the operator's
 * decision. The `AgentRunner` supplies one that emits `PlanProposed` and parks
 * until approve/revise/reject, mirroring `askQuestion`. `submittedBlock` is the
 * exact visible protocol fence when the harness streamed it into the transcript;
 * payload-only submissions omit it so unrelated visible HTML is preserved.
 */
export type ProposePlan = (
  plan: Plan,
  submittedBlock?: string
) => Effect.Effect<PlanDecision>

/**
 * What the adapter is handed for a run: an ordered `emit` sink for normalized
 * events, the `canUseTool` gate, `askQuestion` for structured input, and
 * `proposePlan` for plan-mode review. Because the adapter drives a single fiber
 * that interleaves these in program order, the transcript order (where a
 * gate/question/plan lands) is deterministic.
 */
/**
 * Stop ONE background task by its harness task id.
 *
 * Per-run rather than a method on the adapter because the handle only exists
 * while the harness process is alive — a background task cannot outlive the
 * process that owns it, so a stale handle would be worse than none.
 */
export type StopBackgroundTask = (taskId: string) => Promise<void>

export type TurnSteerResult = "accepted" | "deferred"
export type SteerTurn = (
  text: string,
  images: ReadonlyArray<Attachment>
) => Promise<TurnSteerResult>

/**
 * Provider-neutral result of steering an addressable plan participant.
 * `unavailable` is reserved for a stale routing identity; `failed` means the
 * same identity may be retried because its live control channel was temporarily
 * absent or rejected the steer.
 */
export type PlanParticipantSteerResult =
  | { readonly status: "delivered"; readonly reply: string | null }
  | { readonly status: "unavailable"; readonly detail: string }
  | { readonly status: "failed"; readonly detail: string }

export interface AgentContext {
  readonly emit: (event: StreamEvent) => Effect.Effect<void>
  readonly canUseTool: CanUseTool
  readonly askQuestion: AskQuestion
  readonly proposePlan: ProposePlan
  /**
   * Publish a handle the operator's "Stop" button can reach. Adapters whose
   * harness has no per-task cancellation (codex, opencode — both can only abort
   * a whole turn) simply never call this, and the UI reports the capability as
   * unsupported rather than offering a button that does nothing.
   */
  readonly registerBackgroundStop: (stop: StopBackgroundTask) => Effect.Effect<void>
  /**
   * Publish Codex's live `turn/steer` handle. Passing null marks phases such as
   * native compaction where direct input is temporarily unavailable.
   */
  readonly registerTurnSteer?: (steer: SteerTurn | null) => Effect.Effect<void>
}

/**
 * The contract for wrapping a native coding CLI. A real headless adapter
 * (`claude -p --output-format stream-json`, codex/cursor equivalents) parses its
 * CLI's stream into normalized `StreamEvent`s (via `ctx.emit`) and calls
 * `ctx.canUseTool` before gated actions. Everything downstream (persistence, UI)
 * only sees `StreamEvent`, so the experience is identical across harnesses.
 */
export interface CliAdapterShape {
  readonly run: (
    sessionId: string,
    spec: SessionSpec,
    ctx: AgentContext
  ) => Effect.Effect<void, CliExecError>
  readonly stop: (sessionId: string) => Effect.Effect<void, CliExecError>
}

export class CliAdapter extends Context.Tag("@jingler/CliAdapter")<
  CliAdapter,
  CliAdapterShape
>() {}

/**
 * A deterministic scripted plan — the design's "Refactor auth flow" (6 steps,
 * one branch), used by the plan-mode e2e/tests. `rev` bumps the id/summary so a
 * revision cycle yields a distinct plan part.
 */
/**
 * The decision flow for the branch step (04 "Handle token refresh") — flows now
 * live per-step, so it hangs off that step rather than the whole plan.
 */
const refreshFlow: NonNullable<Plan["steps"][number]["graph"]> = {
  nodes: [
    { id: "n0", label: "HTTP request", kind: "start", detail: null, stepId: null },
    { id: "n1", label: "authMiddleware", kind: "action", detail: "src/auth/session.ts", stepId: null },
    { id: "n2", label: "token expired?", kind: "decision", detail: null, stepId: null },
    { id: "n3", label: "refresh() + retry once", kind: "action", detail: "src/auth/refresh.ts", stepId: null },
    { id: "n4", label: "proceed", kind: "action", detail: null, stepId: null },
    { id: "n5", label: "response", kind: "terminal", detail: null, stepId: null }
  ],
  edges: [
    { id: "e0", from: "n0", to: "n1", label: null },
    { id: "e1", from: "n1", to: "n2", label: null },
    { id: "e2", from: "n2", to: "n3", label: "yes" },
    { id: "e3", from: "n2", to: "n4", label: "no" },
    { id: "e4", from: "n3", to: "n5", label: null },
    { id: "e5", from: "n4", to: "n5", label: null }
  ]
}

/**
 * The canonical plan the scripted agent hands back, as valid plan HTML.
 *
 * Plans are HTML documents now (`@jingler/core` `plan-html.ts`), rendered in the
 * Tiptap "Notion-doc" editor. `PlanStore.promote` persists `plan.raw` verbatim
 * when it is already valid plan HTML (else it folds the legacy structured plan),
 * so emitting the document directly here is what drives `current-plan.html`. The
 * `data-acceptance` ids MUST match the `PLAN_RESULT criterion=…` markers the
 * approval run streams below, or the plan never reaches "done". Every criterion
 * starts `pending` so a resume (which streams no evidence) lands on
 * "needs-verification" while an approval (which does) reaches "done". A mermaid
 * `data-diagram` block exercises the diagram render path in Plan Review.
 */
const scriptedPlanHtml = (
  summary: string,
  holdWorker = false,
  includeAuditStage = false
): string => `<h1>PRD: ${summary}</h1>
<h2>Context</h2>
<p>Move session token handling into a dedicated TokenStore, add a guarded 401-retry refresh path, update the tests, and open a PR.</p>
<h2>Technical design</h2>
<p>The request path flows through the auth middleware, which consults the new TokenStore before proceeding or refreshing an expired token.</p>
<div data-diagram="mermaid"><pre>graph TD; A--&gt;B</pre></div>
<section data-stage="s_01" data-title="Audit session middleware" data-depends-on="" data-complexity="low">
<h3>Intent</h3>
<p>See how sessions read tokens today.</p>
<div data-assignment data-agent-id="worker-auth" data-cli="claude" data-model="opus" data-reason="The dependent auth stages share one context and benefit from strong implementation reasoning." data-status="queued"></div>
<h3>Approach</h3>
<ol><li>Read session.ts</li><li>Trace the token path</li></ol>
<ul data-files><li data-change="M" data-added="0" data-removed="0">src/auth/memory-store.ts</li></ul>
<div data-acceptance="s_01.1" data-status="pending">The current token read path is documented.</div>
</section>
<section data-stage="s_02" data-title="Create TokenStore module" data-depends-on="s_01" data-complexity="medium">
<h3>Intent</h3>
<p>A dedicated store for token lifecycle.</p>
<div data-assignment data-agent-id="worker-auth" data-cli="claude" data-model="opus" data-reason="The dependent auth stages share one context and benefit from strong implementation reasoning." data-status="queued"></div>
<ul data-files><li data-change="A" data-added="40" data-removed="0">src/auth/token-store.ts</li></ul>
<div data-acceptance="s_02.1" data-status="passed">TokenStore exposes get/set/refresh and is covered by tests.</div>
</section>
<section data-stage="s_03" data-title="Swap MemoryStore to TokenStore" data-depends-on="s_02" data-complexity="medium">
<h3>Intent</h3>
<p>Route the session through the new store.</p>
<div data-assignment data-agent-id="worker-auth" data-cli="claude" data-model="opus" data-reason="The dependent auth stages share one context and benefit from strong implementation reasoning." data-status="queued"></div>
<ul data-files><li data-change="M" data-added="8" data-removed="3">src/auth/session.ts</li></ul>
<div data-acceptance="s_03.1" data-status="pending">Session reads route through TokenStore.</div>
</section>
<section data-stage="s_04" data-title="Handle token refresh" data-depends-on="s_03" data-complexity="high">
<h3>Intent</h3>
<p>Decide the refresh path on expiry.</p>
<div data-assignment data-agent-id="worker-auth" data-cli="claude" data-model="opus" data-reason="The dependent auth stages share one context and benefit from strong implementation reasoning." data-status="queued"></div>
<ul data-files><li>src/auth/refresh.ts</li></ul>
<div data-acceptance="s_04.1" data-status="pending">The refresh decision is specified.</div>
</section>
<section data-stage="s_4a" data-title="refresh() and retry on 401" data-depends-on="s_04" data-complexity="high">
<h3>Intent</h3>
<p>Mint a new token and replay once.</p>
<div data-assignment data-agent-id="worker-auth" data-cli="claude" data-model="opus" data-reason="The dependent auth stages share one context and benefit from strong implementation reasoning." data-status="queued"></div>
<ul data-files><li data-change="M" data-added="18" data-removed="0">src/auth/refresh.ts</li><li data-change="A" data-added="15" data-removed="0">src/auth/retry.ts</li></ul>
<div data-acceptance="s_4a.1" data-status="passed">A new token is written before the replay.</div>
<div data-acceptance="s_4a.2" data-status="passed">Refresh fires at most once per request.</div>
<div data-acceptance="s_4a.3" data-status="failed">No refresh loop on repeated 401s.</div>
<div data-acceptance="s_4a.4" data-status="pending">Concurrent requests share a single refresh.</div>
</section>
<section data-stage="s_4b" data-title="Proceed with request" data-depends-on="s_04" data-complexity="low">
<h3>Intent</h3>
<p>Token still valid, carry on.</p>
<div data-assignment data-agent-id="worker-auth" data-cli="claude" data-model="opus" data-reason="The dependent auth stages share one context and benefit from strong implementation reasoning." data-status="queued"></div>
<ul data-files><li>src/auth/session.ts</li></ul>
<div data-acceptance="s_4b.1" data-status="pending">A valid token proceeds without refreshing.</div>
</section>
<section data-stage="s_05" data-title="Update auth tests" data-depends-on="s_4a s_4b" data-complexity="medium">
<h3>Intent</h3>
<p>Cover the new store and the refresh path.</p>
<div data-assignment data-agent-id="worker-auth" data-cli="claude" data-model="opus" data-reason="The dependent auth stages share one context and benefit from strong implementation reasoning." data-status="queued"></div>
<ul data-files><li data-change="M" data-added="24" data-removed="2">src/auth/session.test.ts</li></ul>
<div data-acceptance="s_05.1" data-status="pending">Tests cover the store, the 401 retry${summary.includes("(revised)") ? ", and the requested audit amendment" : ""}.</div>
</section>
<section data-stage="s_06" data-title="Open PR #482" data-depends-on="" data-complexity="low">
<h3>Intent</h3>
<p>Ship the refactor for review.</p>
${holdWorker ? "<p>[[worker-hold]] Wait for an explicit stop before completing the first attempt.</p>" : ""}
<div data-assignment data-agent-id="worker-release" data-cli="codex" data-model="gpt-5.6-sol" data-reason="Release preparation is independent and can run concurrently on a lower-cost route." data-status="queued"></div>
<ul data-files><li>CHANGELOG.md</li></ul>
<div data-acceptance="s_06.1" data-status="pending">A PR is opened against main.</div>
</section>
${
  includeAuditStage
    ? `<section data-stage="s_07" data-title="Add independent audit coverage" data-depends-on="" data-complexity="low">
<h3>Intent</h3>
<p>Add the requested audit amendment as an independent verification component.</p>
<ul data-files><li>src/auth/audit.test.ts</li></ul>
<div data-acceptance="s_07.1" data-status="pending">Independent audit coverage completes with recorded evidence.</div>
</section>`
    : ""
}
<h2>Testing</h2>
<p>Each stage records acceptance evidence before the plan can be marked done.</p>
<h2>Rollout</h2>
<p>Implement stages in order and keep the canonical revision recoverable.</p>`

export const scriptedPlan = (
  sessionId: string,
  rev: number,
  holdWorker = false
): Plan => ({
  id: `plan_${sessionId}_${rev}`,
  summary: rev > 1 ? "Refactor auth flow (revised)" : "Refactor auth flow",
  structured: true,
  graph: null,
  steps: [
    { id: "s_01", number: "01", title: "Audit session middleware", intent: "See how sessions read tokens today.", approach: ["Read session.ts", "Trace the token path"], kind: "step", condition: null, parentId: null, dependsOn: [], blocks: [], files: [{ path: "src/auth/memory-store.ts", change: "M", added: 0, removed: 0 }], guards: [], code: null, diff: null, status: "proposed", flagged: false },
    { id: "s_02", number: "02", title: "Create TokenStore module", intent: "A dedicated store for token lifecycle.", approach: ["Add token-store.ts", "Expose get/set/refresh"], kind: "step", condition: null, parentId: null, dependsOn: ["01"], blocks: [], files: [{ path: "src/auth/token-store.ts", change: "A", added: 40, removed: 0 }], guards: [{ text: "Store is covered by tests", status: "ok" }], code: { lang: "ts", body: "export class TokenStore extends Effect.Service<TokenStore>()(\"TokenStore\", {\n  effect: Effect.gen(function* () {\n    const store = yield* KeyValueStore\n    return {\n      get: (id: string) =>\n        store.get(`token:${id}`).pipe(Effect.map(Option.getOrNull)),\n      set: (id: string, token: Token) =>\n        store.set(`token:${id}`, token),\n      refresh: (session: Session) =>\n        Effect.gen(function* () {\n          const next = yield* mintToken(session)\n          yield* store.set(`token:${session.id}`, next)\n          return next\n        })\n    }\n  })\n}) {}" }, diff: { added: 40, removed: 0 }, status: "proposed", flagged: false },
    { id: "s_03", number: "03", title: "Swap MemoryStore → TokenStore", intent: "Route the session through the new store.", approach: ["Replace the import", "Update call sites"], kind: "step", condition: null, parentId: null, dependsOn: ["02"], blocks: [], files: [{ path: "src/auth/session.ts", change: "M", added: 8, removed: 3 }], guards: [], code: { lang: "ts", body: "-import { MemoryStore } from \"./memory-store.js\"\n+import { TokenStore } from \"./token-store.js\"\n\n export const readSession = (id: string) =>\n   Effect.gen(function* () {\n-    const token = yield* MemoryStore.get(id)\n+    const token = yield* TokenStore.get(id)\n     return decode(token)\n   })" }, diff: { added: 8, removed: 3 }, status: "current", flagged: false },
    { id: "s_04", number: "04", title: "Handle token refresh", intent: "Decide the refresh path on expiry.", approach: [], kind: "branch", condition: "token expired?", parentId: null, dependsOn: ["03"], blocks: ["05"], files: [], guards: [], code: null, graph: refreshFlow, diff: null, status: "proposed", flagged: false },
    { id: "s_4a", number: "4a", title: "refresh() + retry on 401", intent: "Mint a new token and replay once.", approach: ["Detect a 401", "Call refresh(session)", "Replay the request once"], kind: "branch-arm", condition: null, parentId: "s_04", dependsOn: ["03"], blocks: ["05"], files: [{ path: "src/auth/refresh.ts", change: "M", added: 18, removed: 0 }, { path: "src/auth/retry.ts", change: "A", added: 15, removed: 0 }], guards: [{ text: "New token written before the replay", status: "ok" }, { text: "Refresh fires at most once per request", status: "ok" }, { text: "No refresh loop on repeated 401", status: "warn" }, { text: "Concurrent requests share a single refresh", status: "open" }], code: { lang: "ts", body: "export const withRetry = (req: Request, session: Session) =>\n  send(req).pipe(\n    Effect.catchIf(\n      (e) => e.status === 401,\n      () =>\n        Effect.gen(function* () {\n          yield* TokenStore.refresh(session) // once — guarded by a single-flight\n          return yield* send(req)\n        })\n    )\n  )" }, diff: { added: 42, removed: 1 }, status: "proposed", flagged: false },
    { id: "s_4b", number: "4b", title: "Proceed with request", intent: "Token still valid — carry on.", approach: [], kind: "branch-arm", condition: null, parentId: "s_04", dependsOn: [], blocks: [], files: [], guards: [], code: null, diff: null, status: "proposed", flagged: false },
    { id: "s_05", number: "05", title: "Update auth tests", intent: "Cover the new store + refresh path.", approach: ["Add token-store tests", "Add a 401-retry test"], kind: "step", condition: null, parentId: null, dependsOn: ["04"], blocks: [], files: [{ path: "src/auth/session.test.ts", change: "M", added: 24, removed: 2 }], guards: [], code: { lang: "ts", body: "it(\"refreshes once and replays on a 401\", () =>\n  Effect.gen(function* () {\n    const session = yield* seedSession({ expired: true })\n    const res = yield* withRetry(makeRequest(), session)\n    expect(res.status).toBe(200)\n    expect(refreshSpy).toHaveBeenCalledTimes(1) // no refresh loop\n  }).pipe(Effect.provide(TestTokenStore), Effect.runPromise))" }, diff: { added: 24, removed: 2 }, status: "proposed", flagged: false },
    { id: "s_06", number: "06", title: "Open PR #482", intent: "Ship the refactor for review.", approach: ["Push the branch", "Open a PR against main"], kind: "step", condition: null, parentId: null, dependsOn: ["05"], blocks: [], files: [], guards: [], code: null, diff: null, status: "proposed", flagged: false }
  ],
  comments: [],
  status: "proposed",
  raw: scriptedPlanHtml(
    rev > 1 ? "Refactor auth flow (revised)" : "Refactor auth flow",
    holdWorker
  )
})

/**
 * The scripted run body — a deterministic sequence (thinking, reads, a gated
 * edit, a gated shell command) driving the full contract without a real process.
 * Reused by both `makeScriptedCliAdapter`'s Layer and the harness dispatcher's
 * fallback (tests / e2e / no-CLI-installed). `delayMs` paces the stream.
 *
 * Markers in the prompt drive the interactive flows: `[[ask]]` → AskUserQuestion,
 * `[[plan]]` → propose a plan and honour the approve/revise decision.
 * `[[stream-plan]]` adds cumulative live-only snapshots before that promotion.
 * `[[queue-hold]]` parks a test turn so queue affordances can be exercised
 * without borrowing the plan-approval lifecycle.
 */
export const scriptedRun =
  (delayMs: number): CliAdapterShape["run"] =>
  (sessionId, spec, { emit, canUseTool, askQuestion, proposePlan, registerBackgroundStop, registerTurnSteer }) =>
    Effect.gen(function* () {
      const pause = delayMs > 0 ? Effect.sleep(`${delayMs} millis`) : Effect.void

      // A context-digest run. The scripted adapter exists to drive the FULL
      // contract without a real process, and summarising a session is now part
      // of that contract — without this branch the e2e suite could reach
      // compaction but never complete one, because `parseDigest` would reject
      // the generic scripted reply and the session would silently not compact.
      //
      // Keyed on a phrase from `digestPrompt` rather than a `[[marker]]`: the
      // digest prompt is generated by Jingler, not typed by a user, so there is
      // nowhere to put a marker that a real harness wouldn't also receive.
      if (spec.prompt.includes("You are compacting a coding session's context")) {
        yield* emit({ _tag: "Started", sessionId })
        const digestReply = `\`\`\`json
{
  "goal": "Add rate limiting to the refund endpoint",
  "decisions": ["Reused the token bucket in lib/ratelimit.ts rather than adding a dependency"],
  "filesTouched": ["src/routes/billing.ts"],
  "openThreads": ["The 429 test still needs writing"],
  "preferences": ["Prefers Effect over raw async"]
}
\`\`\``
        // Stream the reply as many small deltas, NOT one blob. A real harness
        // emits assistant text token by token (`text_delta`), so a faithful
        // scripted digest must too — otherwise the e2e path never exercises how
        // the manager REASSEMBLES those fragments. Fixed-size chunks guarantee a
        // boundary lands mid-string, which is exactly the shape that regressed:
        // reassembling with "\n" instead of "" put a raw newline inside a JSON
        // string and made every real digest fail to parse. Chunking the whole
        // string keeps this true even if the reply above is later edited.
        for (let i = 0; i < digestReply.length; i += 17) {
          yield* emit({ _tag: "Assistant", text: digestReply.slice(i, i + 17) })
        }
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      yield* emit({ _tag: "Started", sessionId })
      yield* pause

      // A deterministic busy window for queue E2E. Plan approval used to stand
      // in for this, but messages sent against a proposed plan are now revision
      // feedback by design and must never be treated as an ordinary work queue.
      if (spec.prompt.includes("[[queue-hold]]")) {
        yield* emit({ _tag: "Assistant", text: "Holding the active turn for queue actions." })
        yield* Effect.never
        return
      }

      // Provider-neutral worker turns are launched by OrchestrationService, not
      // by the session's planning harness. Keep this branch visibly paced so
      // Electron coverage can observe independent owners running concurrently,
      // then return the exact evidence protocol the service persists.
      if (
        spec.prompt.includes("[[orchestration-worker]]") ||
        spec.prompt.includes("executing an approved Jingler plan")
      ) {
        yield* emit({
          _tag: "Thinking",
          text: "Executing the assigned stage and its verification.",
          seconds: 2,
          done: true
        })
        yield* pause
        yield* emit({
          _tag: "ToolStart",
          id: `worker-test-${sessionId}`,
          name: "Bash",
          target: "pnpm test"
        })
        if (
          spec.prompt.includes("[[worker-hold]]") &&
          spec.resumeId === null
        ) {
          yield* Effect.never
        }
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: `worker-test-${sessionId}`,
          status: "success",
          meta: "scripted verification passed",
          diff: null,
          preview: null
        })
        yield* pause
        const criteria =
          /Criteria:\s*([^\n]+)/.exec(spec.prompt)?.[1]
            ?.split(",")
            .map((criterion) => criterion.trim())
            .filter((criterion) => criterion.length > 0) ?? []
        yield* emit({
          _tag: "Assistant",
          text: criteria
            .map(
              (criterion) =>
                `PLAN_RESULT criterion=${criterion} status=passed evidence=Scripted worker completed and verified its assigned stage.`
            )
            .join("\n")
        })
        yield* emit({ _tag: "Done", costUsd: 0.01, tokens: 120 })
        return
      }

      // A `[[background]]` marker starts a background task that keeps running
      // after the turn ends — the case the dock exists for, and the only way to
      // drive it end-to-end without a real harness. The registered stop handle
      // settles it the way a real one does: by reporting the outcome back through
      // the same signals, rather than mutating state behind the registry's back.
      // A `[[background-agent]]` marker drives the ONE case that used to show the
      // same work twice: a sub-agent that opens a tab at tool_use time and is only
      // then revealed to be backgrounded. The tab must be retracted and the dock
      // row must be the only trace of it.
      if (spec.prompt.includes("[[background-agent]]")) {
        const taskId = `bgagent_${sessionId}`
        const toolUseId = `toolu_${sessionId}`
        yield* emit({
          _tag: "SubagentStarted",
          id: toolUseId,
          name: "Explore",
          description: "Survey the codebase",
          parentId: null
        })
        yield* emit({
          _tag: "BackgroundTaskStarted",
          id: taskId,
          description: "Surveying the codebase",
          taskType: "subagent",
          subagentType: "Explore",
          toolUseId
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [taskId] })
        yield* emit({ _tag: "Assistant", text: "Delegated the survey to a background agent." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      /**
       * A turn HELD OPEN by sub-agents that are still working.
       *
       * The shape the real Claude adapter now has (see `turn-continuation.ts`): the
       * main agent stops talking, but its `Done` is WITHHELD because the sub-agents
       * it delegated to are still running inside the same query. The regression this
       * drives is the one the operator reported — talking to the main agent killed
       * every sub-agent, because settling the turn closed the query all of them ran
       * in and the runner then reaped the process.
       *
       * The steer handle is registered for the whole held window, exactly as the
       * real adapter's is, so a message sent mid-flight lands in THIS turn instead
       * of stopping it and starting another.
       */
      if (spec.prompt.includes("[[held-subagents]]")) {
        const first = `toolu_a_${sessionId}`
        const second = `toolu_b_${sessionId}`
        // The steered text, handed to the event loop below rather than emitted here.
        //
        // A steer handler MUST NOT call `emit`: the runner serializes both behind one
        // semaphore (`agent-runner.ts`, `turnMutation`), so emitting while the steer
        // holds the permit deadlocks — the message hangs on "Sending" and the reply
        // never renders. The real adapters don't either; they hand the harness the
        // text and its answer comes back through the stream a beat later. This models
        // that: the handle only accepts, and the window emits the acknowledgement.
        let pendingSteer: string | null = null
        let steered = false
        if (registerTurnSteer !== undefined) {
          yield* registerTurnSteer((text) => {
            pendingSteer = text
            return Promise.resolve("accepted" as const)
          })
        }
        for (const [id, description] of [[first, "Survey the tab bar"], [second, "Audit the theme tokens"]] as const) {
          yield* emit({ _tag: "SubagentStarted", id, name: "Explore", description, parentId: null })
        }
        yield* emit({ _tag: "Assistant", text: "Delegated to two agents." })
        // The main agent's `result` lands about here. Nothing terminal is emitted:
        // the sub-agents are still working, so the turn is not over.
        //
        // The held window is then paced by REPEATED tool boundaries rather than one.
        // The renderer's steer queue flushes only on a `ToolEnd`
        // (`conversation-machine.ts`, `canAutoFlush`), so a single boundary makes the
        // e2e a race: the spec has to see four elements, fill the composer and land
        // its Enter inside one 300ms gap, and on a slow machine the message queues
        // just AFTER the only boundary, replays as a fresh turn after `Done`, and the
        // steer never renders. A boundary every 300ms across the window means a steer
        // sent at any point in it is flushed by the next one.
        //
        // The window's LENGTH is the other half of that race. Eight ticks is 2.4s, and
        // the spec has to see four elements and type before it runs out — which it does
        // not reliably do on a loaded machine, so the turn settles first and the message
        // replays as a fresh turn. So the window runs until the steer has been seen AND
        // two more boundaries have flushed it, with a hard cap so a run that never
        // steers (the `stop` spec below) still terminates.
        const MIN_TICKS = 8
        const MAX_TICKS = 60 // 18s — past any Playwright assertion in the window
        let ticksAfterSteer = 0
        for (let tick = 0; tick < MAX_TICKS; tick++) {
          if (pendingSteer !== null) {
            yield* emit({ _tag: "Assistant", text: `Noted: ${pendingSteer}` })
            pendingSteer = null
            steered = true
          }
          if (steered) ticksAfterSteer++
          if (tick >= MIN_TICKS && ticksAfterSteer >= 2) break
          yield* Effect.sleep("300 millis")
          yield* emit({ _tag: "Assistant", text: "reading the tab bar", agentId: first })
          yield* emit({
            _tag: "ToolStart",
            id: `read_${sessionId}_${tick}`,
            name: "Read",
            target: "tabs.tsx",
            agentId: first
          })
          yield* emit({
            _tag: "ToolEnd",
            id: `read_${sessionId}_${tick}`,
            status: "success",
            meta: null,
            diff: null,
            preview: null,
            agentId: first
          })
        }
        // One last boundary-free tail, so the steer is demonstrably flushed by a
        // sub-agent's own work rather than by the turn settling.
        yield* Effect.sleep("300 millis")
        yield* emit({ _tag: "SubagentEnded", id: first, status: "done" })
        yield* emit({ _tag: "SubagentEnded", id: second, status: "done" })
        // Only now is the turn genuinely finished.
        yield* emit({ _tag: "Assistant", text: "Both agents reported back." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        if (registerTurnSteer !== undefined) yield* registerTurnSteer(null)
        return
      }

      /**
       * A harness that is STILL ALIVE after the turn it just ended.
       *
       * This is what the real Claude adapter does and the plain `[[background]]`
       * marker does not: its `for await` over the SDK never breaks on `result`, so
       * `run` keeps consuming — that is how a backgrounded task's
       * `task_notification` bookend arrives after `Done`. The scripted harness
       * returning immediately made that whole window untestable, and the window is
       * exactly where the chat's run reservation is still held while the renderer,
       * which went idle on `Done`, shows a send button.
       */
      if (spec.prompt.includes("[[background-live-harness]]")) {
        yield* emit({
          _tag: "BackgroundTaskStarted",
          id: `bglive_${sessionId}`,
          description: "Watching the test suite",
          taskType: "bash",
          subagentType: null,
          toolUseId: null
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [`bglive_${sessionId}`] })
        yield* emit({ _tag: "Assistant", text: "Started a watcher in the background." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        // Deliberately no `return`: the turn has settled but the harness has not
        // exited, which is the real adapter's shape.
        yield* Effect.sleep("60 seconds")
        return
      }

      /**
       * A background task that FINISHES on its own, after its turn is over.
       *
       * The bookend is the whole point: a real harness reports settlement through a
       * later `task_notification`, which only arrives if the process is still
       * consuming — so this is the case that proves the run outlives the turn and
       * the dock learns the outcome without the operator prompting again.
       */
      if (spec.prompt.includes("[[background-completes]]")) {
        const taskId = `bgdone_${sessionId}`
        yield* emit({
          _tag: "BackgroundTaskStarted",
          id: taskId,
          description: "Watching the test suite",
          taskType: "bash",
          subagentType: null,
          toolUseId: null
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [taskId] })
        yield* emit({ _tag: "Assistant", text: "Started a watcher in the background." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        // The turn is over. The work is not.
        yield* Effect.sleep("2 seconds")
        yield* emit({
          _tag: "BackgroundTaskSettled",
          id: taskId,
          status: "completed",
          summary: "42 tests passed.",
          outputFile: null
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [] })
        return
      }

      if (spec.prompt.includes("[[background]]")) {
        const taskId = `bgtask_${sessionId}`
        yield* registerBackgroundStop(async (id) => {
          if (id !== taskId) return
          await Effect.runPromise(
            emit({
              _tag: "BackgroundTaskSettled",
              id: taskId,
              status: "stopped",
              summary: "Stopped by the operator.",
              outputFile: null
            }).pipe(Effect.zipRight(emit({ _tag: "BackgroundTasksChanged", ids: [] })))
          )
        })
        yield* emit({
          _tag: "BackgroundTaskStarted",
          id: taskId,
          description: "Watching the test suite",
          taskType: "bash",
          subagentType: null,
          toolUseId: null
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [taskId] })
        yield* emit({
          _tag: "BackgroundTaskProgress",
          id: taskId,
          description: "Watching the test suite",
          tokens: 1200,
          toolUses: 3,
          durationMs: 12_000,
          lastTool: "Bash"
        })
        yield* emit({ _tag: "Assistant", text: "Started a watcher in the background." })
        // The turn ENDS while the task runs on — exactly the situation that made
        // this work invisible before the dock existed.
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // Once an orchestrator plan is approved, later plan amendments run in auto
      // mode and return the complete revised document inline. Model that contract
      // directly so the runner exercises amendment reconciliation without opening
      // a second approval gate.
      if (spec.prompt.includes("[[amendment]]") && spec.mode !== "plan") {
        yield* emit({
          _tag: "Thinking",
          text: "Folding the requested audit amendment into the approved plan.",
          seconds: 2,
          done: true
        })
        yield* pause
        yield* emit({
          _tag: "Assistant",
          text: `Folding that in.\n\n\`\`\`\`html\n${scriptedPlanHtml("Refactor auth flow (revised)", false, true)}\n\`\`\`\``
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[plan]]` marker drives plan mode: propose a plan, then execute on
      // approval or re-propose a revised one on revise (one cycle max, for tests).
      if (spec.prompt.includes("[[plan]]") || spec.mode === "plan") {
        yield* emit({ _tag: "Thinking", text: "Mapping out the work before touching anything.", seconds: 3, done: true })
        yield* pause
        const exposesPlanAgent = spec.prompt.includes("[[active-plan-agent]]")
        const planAgentId = `plan_agent_${sessionId}`
        let pendingPlanThreadRelay: string | null = null
        if (exposesPlanAgent) {
          yield* emit({
            _tag: "SubagentStarted",
            id: planAgentId,
            name: "Explore",
            description: "Review the streamed plan with the operator",
            parentId: null
          })
          if (registerTurnSteer !== undefined) {
            yield* registerTurnSteer((text) => {
              pendingPlanThreadRelay = text
              return Promise.resolve("accepted" as const)
            })
            yield* Effect.fork(
              Effect.forever(
                Effect.sleep("25 millis").pipe(
                  Effect.zipRight(
                    Effect.gen(function* () {
                      const relay = pendingPlanThreadRelay
                      if (relay === null) return
                      pendingPlanThreadRelay = null
                      yield* emit({
                        _tag: "Assistant",
                        text: relay.includes("Relay this message to the active nested agent")
                          ? "Explore confirms the anchored rollout guidance is safe to keep."
                          : "The orchestrator has reviewed the plan comment."
                      })
                    })
                  )
                )
              )
            )
          }
        }
        let rev = spec.prompt.includes("[[amendment]]") ? 2 : 1
        while (true) {
          if (spec.prompt.includes("[[stream-plan]]")) {
            const source = scriptedPlan(
              sessionId,
              rev,
              spec.prompt.includes("[[worker-hold]]")
            ).raw
            const h1End = source.indexOf("</h1>") + "</h1>".length
            const contextEnd =
              source.indexOf("</p>", source.indexOf("<h2>Context</h2>")) +
              "</p>".length
            const firstStageEnd =
              source.indexOf("</section>") + "</section>".length
            const boundaries = [
              h1End,
              contextEnd,
              firstStageEnd,
              source.length
            ]
            for (const [index, end] of boundaries.entries()) {
              yield* emit({
                _tag: "PlanDraft",
                draft: {
                  id: `plan_${sessionId}_${rev}`,
                  source: source.slice(0, end),
                  phase:
                    index === boundaries.length - 1
                      ? "complete"
                      : "composing"
                }
              })
              yield* pause
            }
          }
          const decision = yield* proposePlan(
            scriptedPlan(
              sessionId,
              rev,
              spec.prompt.includes("[[worker-hold]]")
            )
          )
          if (decision._tag === "Approve") {
            yield* emit({ _tag: "Assistant", text: "Plan approved — executing the steps." })
            yield* pause
            // Each edit's path matches a plan step's files, so the runner marks that
            // step done — exercising the execution → plan-progress linkage.
            const edits: ReadonlyArray<{ id: string; path: string; preview: string; diff: { added: number; removed: number } }> = [
              { id: "plan-edit-1", path: "src/auth/token-store.ts", preview: "+export class TokenStore {\n+  // …\n+}", diff: { added: 40, removed: 0 } },
              { id: "plan-edit-2", path: "src/auth/session.ts", preview: "-import { MemoryStore } from \"./memory-store.js\"\n+import { TokenStore } from \"./token-store.js\"", diff: { added: 8, removed: 3 } },
              { id: "plan-edit-3", path: "src/auth/session.test.ts", preview: "+it(\"refreshes once and replays on a 401\", () => {\n+  // …\n+})", diff: { added: 24, removed: 2 } }
            ]
            for (const e of edits) {
              yield* emit({ _tag: "ToolStart", id: e.id, name: "Write", target: e.path })
              yield* pause
              yield* emit({ _tag: "ToolEnd", id: e.id, status: "success", meta: null, diff: e.diff, preview: e.preview })
              yield* pause
            }
            const evidenceReply = [
              "Steps 2, 3 and 5 are done.",
              ...[
                "s_01.1",
                "s_02.1",
                "s_03.1",
                "s_04.1",
                "s_4a.1",
                "s_4a.2",
                "s_4a.3",
                "s_4a.4",
                "s_4b.1",
                "s_05.1",
                "s_06.1"
              ].map(
                (criterion) =>
                  `PLAN_RESULT criterion=${criterion} status=passed evidence=Scripted implementation completed and verified.`
              )
            ].join("\n")
            // Claude delivers text token-by-token. Fragment the protocol across
            // arbitrary event boundaries so the runner must parse the settled
            // assistant message, never one delta in isolation.
            for (let offset = 0; offset < evidenceReply.length; offset += 17) {
              yield* emit({
                _tag: "Assistant",
                text: evidenceReply.slice(offset, offset + 17)
              })
            }
            break
          }
          if (decision._tag === "Delegate") {
            yield* emit({
              _tag: "Assistant",
              text: "Plan approved — Jingler assigned it to worker agents."
            })
            break
          }
          if (decision._tag === "Reject" || rev >= 2) {
            yield* emit({ _tag: "Assistant", text: "Holding here until you're ready." })
            break
          }
          yield* emit({ _tag: "Assistant", text: "Good call — revising the plan to guard the refresh loop." })
          yield* pause
          rev += 1
        }
        if (exposesPlanAgent) {
          yield* emit({ _tag: "SubagentEnded", id: planAgentId, status: "done" })
          if (registerTurnSteer !== undefined) yield* registerTurnSteer(null)
        }
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[storm]]` marker emits a run of consecutive tool calls (no text
      // between) so the transcript's collapse-to-latest grouping can be exercised.
      if (spec.prompt.includes("[[storm]]")) {
        yield* emit({ _tag: "Thinking", text: "Scanning the codebase.", seconds: 2, done: true })
        yield* pause
        for (let i = 1; i <= 4; i++) {
          yield* emit({ _tag: "ToolStart", id: `read-${i}`, name: "Read", target: `src/file-${i}.ts` })
          yield* pause
          yield* emit({ _tag: "ToolEnd", id: `read-${i}`, status: "success", meta: `${i * 10} lines`, diff: null, preview: null })
          yield* pause
        }
        yield* emit({ _tag: "Assistant", text: "Scanned four files." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[ask]]` marker in the prompt drives the AskUserQuestion flow (used by
      // the question e2e/tests) instead of the default gated edit/command flow.
      if (spec.prompt.includes("[[ask]]")) {
        yield* emit({
          _tag: "Thinking",
          text: "Before I start I need a couple of decisions.",
          seconds: 2,
          done: true
        })
        yield* pause
        const answers = yield* askQuestion({
          id: `q_${sessionId}`,
          questions: [
            {
              question: "Which token strategy should the store use?",
              header: "Strategy",
              multiSelect: false,
              options: [
                { label: "Rotating refresh tokens", description: "New refresh token on every use — most secure." },
                { label: "Sliding session", description: "Extend expiry on activity, single long-lived token." },
                { label: "Short-lived access + refresh", description: "15-min access, 7-day refresh. The common default." }
              ]
            },
            {
              question: "Which surfaces should adopt the new store?",
              header: "Surfaces",
              multiSelect: true,
              options: [
                { label: "HTTP middleware", description: "Express session guard on the API." },
                { label: "WebSocket handshake", description: "Auth on the realtime channel." },
                { label: "Background workers", description: "Queue consumers acting on a user's behalf." }
              ]
            }
          ]
        })
        const summary = answers
          .map((a) => [...a.selected, ...(a.other ? [a.other] : [])].join(", ") || "—")
          .join(" · ")
        yield* emit({ _tag: "Assistant", text: `Got it — starting with: ${summary}.` })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[codex-edit-preview]]` marker gives the Electron suite a deterministic
      // Codex-labelled update + create pair. The scripted adapter stands in for
      // the harness there; the adapter unit tests separately prove that real
      // Codex fileChange payloads produce this same normalized contract.
      if (spec.prompt.includes("[[codex-edit-preview]]")) {
        yield* emit({ _tag: "ToolStart", id: "codex-edit-1", name: "Edit", target: "src/config.ts" })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "codex-edit-1",
          status: "success",
          meta: null,
          diff: { added: 1, removed: 1 },
          preview: "-export const mode = 'legacy'\n+export const mode = 'modern'"
        })
        yield* pause
        yield* emit({ _tag: "ToolStart", id: "codex-create-1", name: "Edit", target: "src/created.ts" })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "codex-create-1",
          status: "success",
          meta: null,
          diff: { added: 1, removed: 0 },
          preview: "+export const created = true"
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // Models the older/partial Codex file-change shape that reports a
      // successful Edit without diff metadata. The Electron regression creates
      // this file after the initial workspace listing, then proves the ToolEnd
      // refresh makes the absolute path in the response open the Preview dock.
      if (spec.prompt.includes("[[codex-open-created-file]]")) {
        const relativePath = "reports/codex-created.md"
        const absolutePath = `${spec.cwd}/${relativePath}`
        yield* emit({
          _tag: "ToolStart",
          id: "codex-open-created-1",
          name: "Edit",
          target: absolutePath
        })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "codex-open-created-1",
          status: "success",
          meta: null,
          diff: null,
          preview: null
        })
        yield* emit({
          _tag: "Assistant",
          text: `Created [codex-created.md](${absolutePath}).`
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      yield* emit({ _tag: "Thinking", text: "No limiter middleware exists yet. ", seconds: null, done: false })
      yield* pause
      yield* emit({
        _tag: "Thinking",
        text: "I'll reuse the token-bucket in lib/ratelimit.ts, apply it to POST /refund, then add a 429 test.",
        seconds: 6,
        done: true
      })
      yield* pause
      yield* emit({ _tag: "ToolStart", id: "read-1", name: "Read", target: "src/routes/billing.ts" })
      yield* pause
      yield* emit({ _tag: "ToolEnd", id: "read-1", status: "success", meta: "142 lines", diff: null, preview: null })
      yield* pause
      yield* emit({ _tag: "ToolStart", id: "grep-1", name: "Grep", target: "rateLimit|tokenBucket" })
      yield* pause
      yield* emit({ _tag: "ToolEnd", id: "grep-1", status: "success", meta: "0 hits", diff: null, preview: null })
      yield* pause
      yield* emit({
        _tag: "Assistant",
        text: "No limiter is wired up. Adding the middleware to the refund route and a matching test."
      })
      yield* pause

      // ── Edit (gated on `kind === "edit"`) ──
      const editDecision = yield* canUseTool({
        kind: "edit",
        tool: "Edit",
        target: "src/routes/billing.ts",
        command: null
      })
      if (editDecision === "allow") {
        yield* emit({ _tag: "ToolStart", id: "edit-1", name: "Edit", target: "src/routes/billing.ts" })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "edit-1",
          status: "success",
          meta: null,
          diff: { added: 7, removed: 0 },
          preview: "61  + router.post('/refund', rateLimit(5, '1m'), requireAuth, refundHandler)"
        })
      } else {
        yield* emit({ _tag: "Assistant", text: "Holding the edit until you approve it." })
      }
      yield* pause

      // ── Shell command (gated on `kind === "command"`) ──
      const cmdDecision = yield* canUseTool({
        kind: "command",
        tool: "Bash",
        target: "npm test -- billing",
        command: "npm test -- billing"
      })
      if (cmdDecision === "allow") {
        yield* emit({ _tag: "ToolStart", id: "bash-1", name: "Bash", target: "npm test -- billing" })
        yield* pause
        yield* emit({ _tag: "ToolEnd", id: "bash-1", status: "success", meta: "1 passed", diff: null, preview: null })
      } else {
        yield* emit({ _tag: "Assistant", text: "Left the tests unrun for now." })
      }
      yield* pause
      yield* emit({ _tag: "Done", costUsd: 0.38, tokens: 42_100 })
    })

/**
 * A deterministic adapter driving the full contract without a real process —
 * the tests/e2e/fallback path. `delayMs` paces the stream.
 */
export const makeScriptedCliAdapter = (delayMs: number): Layer.Layer<CliAdapter> =>
  Layer.succeed(CliAdapter, CliAdapter.of({ run: scriptedRun(delayMs), stop: () => Effect.void }))

/** The default scripted adapter, paced for a visible streaming cadence. */
export const ScriptedCliAdapterLive = makeScriptedCliAdapter(320)
