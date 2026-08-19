import type {
  Attachment,
  PermissionMode,
  PiRunSpec,
  Plan,
  PlanPrd,
  QuestionAnswer,
  QuestionRequest,
  StreamEvent
} from "@jingler/core"
import type { AgentRunError } from "@jingler/core"
import { Context, Data, Effect, Layer } from "effect"
import { planTaskProgressFingerprint } from "./plan-task-progress.js"
import type { RuntimeRemoteMcpServer } from "./runtime/mcp/attachment.js"
import type { JinglerMcpAttachments } from "./runtime/tools/mcp-tools.js"
import { isE2eEnv } from "./runtime/e2e-environment.js"

/**
 * A remote MCP attachment ready for an embedded pi run.
 *
 * Main-process only: headers may contain bearer credentials. AgentRunner builds
 * this source-neutral shape immediately before a run; adapters consume it
 * in-memory and never persist or expose it through RPC.
 */
export type RemoteMcpServer = RuntimeRemoteMcpServer

/** Canonical parameters for one turn through the embedded pi runtime. */
export interface AgentTurnSpec extends Omit<PiRunSpec, "runId"> {
  /** Images the operator attached as context for this turn (empty when none). */
  readonly images: ReadonlyArray<Attachment>
  /** Secret-bearing, main-process-only capabilities; never persisted or sent over RPC. */
  /** Run-scoped Jingler MCP capabilities, kept distinct so source risk cannot drift. */
  readonly mcp?: JinglerMcpAttachments
  /** Distinguishes disabled memory from an attempted attachment that failed open. */
  readonly memoryAttachmentStatus?: "disabled" | "available" | "failed"
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
 * A permission resolver the runtime calls before any gated action. The
 * `AgentRunner` applies the session's HITL mode/allowlist and, when it must
 * pause, emits an approval gate and awaits the operator.
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
 * - `Revise` — keep planning, addressing `feedback` (bundled step comments),
 * - `Reject` — abandon the plan (e.g. the run was stopped).
 */
export type PlanDecision = Data.TaggedEnum<{
  Approve: { readonly mode: PermissionMode; readonly plan?: Plan }
  Revise: { readonly feedback: string }
  Reject: {}
}>
export const PlanDecision = Data.taggedEnum<PlanDecision>()

/**
 * Present a structured plan (`mode:"submit"`) and await the operator's decision.
 * The `AgentRunner` supplies one that emits `PlanProposed` and parks until
 * approve/revise/reject, mirroring `askQuestion`. `submittedBlock` is the exact
 * visible ` ```json ` fence when the harness streamed it into the transcript;
 * payload-only submissions omit it so unrelated visible content is preserved.
 */
export type ProposePlan = (
  plan: PlanPrd,
  submittedBlock?: string
) => Effect.Effect<PlanDecision>

/**
 * Persist an agent-emitted plan (`mode:"draft"`) as a DRAFT `PlanDocument`
 * WITHOUT the approval gate `proposePlan` blocks on. Draft mode: a
 * plan the agent shows for iteration populates Plan Review. Never clobbers a
 * non-draft plan, so calling it is always safe. Returns immediately.
 */
export type SaveDraftPlan = (plan: PlanPrd, block?: string) => Effect.Effect<void>
export type DiscardPlan = () => Effect.Effect<void>

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

/**
 * `deferred` is a phase — the channel exists but cannot take the message right
 * now, so the queue retries at the next boundary. `unsupported` will not clear
 * within this run (e.g. the runtime cannot take images mid-turn), which is what
 * licenses the renderer's "Send now" to stop the turn and replay the message as
 * a fresh one — the only delivery that can still honour "now".
 */
export type TurnSteerResult = "accepted" | "deferred" | "unsupported"
export type SteerTurn = (
  text: string,
  images: ReadonlyArray<Attachment>
) => Promise<TurnSteerResult>

export interface AgentContext {
  readonly emit: (event: StreamEvent) => Effect.Effect<void>
  readonly canUseTool: CanUseTool
  readonly askQuestion: AskQuestion
  readonly proposePlan: ProposePlan
  /**
   * Persist an emitted plan as a draft (no approval gate). Optional: only the
   * `AgentRunner` supplies it, and an adapter simply skips draft capture when
   * absent (`ctx.saveDraftPlan?.(source)`).
   */
  readonly saveDraftPlan?: SaveDraftPlan
  /**
   * Discard the canonical plan so the next submission proposes fresh instead of
   * amending. Optional for the same reason as `saveDraftPlan`.
   */
  readonly discardPlan?: DiscardPlan
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
 * Transitional orchestration seam around `AgentRuntime`. Production delegates
 * to embedded pi; deterministic tests supply a scripted driver that emits the
 * same normalized `StreamEvent` contract and permission requests.
 */
export interface AgentTurnDriverShape {
  readonly run: (
    sessionId: string,
    spec: AgentTurnSpec,
    ctx: AgentContext
  ) => Effect.Effect<void, AgentRunError>
  readonly stop: (sessionId: string) => Effect.Effect<void, AgentRunError>
}

export class AgentTurnDriver extends Context.Tag("@jingler/AgentTurnDriver")<
  AgentTurnDriver,
  AgentTurnDriverShape
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
<h3>Approach</h3>
<ol><li>Read session.ts</li><li>Trace the token path</li></ol>
<ul data-files><li data-change="M" data-added="0" data-removed="0">src/auth/memory-store.ts</li></ul>
<div data-acceptance="s_01.1" data-status="pending">The current token read path is documented.</div>
</section>
<section data-stage="s_02" data-title="Create TokenStore module" data-depends-on="s_01" data-complexity="medium">
<h3>Intent</h3>
<p>A dedicated store for token lifecycle.</p>
<ul data-files><li data-change="A" data-added="40" data-removed="0">src/auth/token-store.ts</li></ul>
<div data-acceptance="s_02.1" data-status="passed">TokenStore exposes get/set/refresh and is covered by tests.</div>
</section>
<section data-stage="s_03" data-title="Swap MemoryStore to TokenStore" data-depends-on="s_02" data-complexity="medium">
<h3>Intent</h3>
<p>Route the session through the new store.</p>
<ul data-files><li data-change="M" data-added="8" data-removed="3">src/auth/session.ts</li></ul>
<div data-acceptance="s_03.1" data-status="pending">Session reads route through TokenStore.</div>
</section>
<section data-stage="s_04" data-title="Handle token refresh" data-depends-on="s_03" data-complexity="high">
<h3>Intent</h3>
<p>Decide the refresh path on expiry.</p>
<ul data-files><li>src/auth/refresh.ts</li></ul>
<div data-acceptance="s_04.1" data-status="pending">The refresh decision is specified.</div>
</section>
<section data-stage="s_4a" data-title="refresh() and retry on 401" data-depends-on="s_04" data-complexity="high">
<h3>Intent</h3>
<p>Mint a new token and replay once.</p>
<ul data-files><li data-change="M" data-added="18" data-removed="0">src/auth/refresh.ts</li><li data-change="A" data-added="15" data-removed="0">src/auth/retry.ts</li></ul>
<div data-acceptance="s_4a.1" data-status="passed">A new token is written before the replay.</div>
<div data-acceptance="s_4a.2" data-status="passed">Refresh fires at most once per request.</div>
<div data-acceptance="s_4a.3" data-status="failed">No refresh loop on repeated 401s.</div>
<div data-acceptance="s_4a.4" data-status="pending">Concurrent requests share a single refresh.</div>
</section>
<section data-stage="s_4b" data-title="Proceed with request" data-depends-on="s_04" data-complexity="low">
<h3>Intent</h3>
<p>Token still valid, carry on.</p>
<ul data-files><li>src/auth/session.ts</li></ul>
<div data-acceptance="s_4b.1" data-status="pending">A valid token proceeds without refreshing.</div>
</section>
<section data-stage="s_05" data-title="Update auth tests" data-depends-on="s_4a s_4b" data-complexity="medium">
<h3>Intent</h3>
<p>Cover the new store and the refresh path.</p>
<ul data-files><li data-change="M" data-added="24" data-removed="2">src/auth/session.test.ts</li></ul>
<div data-acceptance="s_05.1" data-status="pending">Tests cover the store, the 401 retry${summary.includes("(revised)") ? ", and the requested audit amendment" : ""}.</div>
</section>
<section data-stage="s_06" data-title="Open PR #482" data-depends-on="" data-complexity="low">
<h3>Intent</h3>
<p>Ship the refactor for review.</p>
${holdWorker ? "<p>[[worker-hold]] Wait for an explicit stop before completing the first attempt.</p>" : ""}
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

/** The structured-DTO counterpart of `scriptedPlan`, for the JSON emission path. */
export const scriptedPlanPrd = (
  sessionId: string,
  rev: number,
  holdWorker = false,
  includeAuditStage = false,
  includeRoutingStage = false
): PlanPrd => {
  const stage = (
    id: string,
    title: string,
    dependencies: ReadonlyArray<string>,
    complexity: "low" | "medium" | "high",
    files: ReadonlyArray<{ path: string; change: "A" | "M" | "D" }>,
    acceptance: ReadonlyArray<{
      id: string
      text: string
      status: "pending" | "passed" | "failed" | "waived"
      testReferences?: ReadonlyArray<{ path: string; cases: ReadonlyArray<string> }>
    }>,
    notes: ReadonlyArray<{ kind: "prose"; id: string; text: string }> = []
  ) => ({
    id,
    title,
    intent: `${title}.`,
    approach: [],
    tasks: [
      {
        id: `${id}.task.1`,
        text: id === "s_01" ? "Trace the existing token path" : `Implement ${title.toLowerCase()}`,
        status: "pending" as const
      },
      {
        id: `${id}.task.2`,
        text: id === "s_01" ? "Document the stage boundary" : `Verify ${title.toLowerCase()}`,
        status: "pending" as const
      }
    ],
    files: files.map((f) => ({ ...f })),
    diagrams: id === "s_01"
      ? [{ id: "audit-flow", source: "flowchart LR\n  Session --> TokenStore" }]
      : [],
    notes,
    walkthrough: [
      {
        kind: "prose" as const,
        id: `${id}-walkthrough-rationale`,
        text: id === "s_01"
          ? "Start at the session boundary so the refactor preserves the current token semantics before introducing a new store."
          : `Implement **${title}** behind the existing boundary so callers keep a stable contract.`
      },
      {
        kind: "code" as const,
        id: `${id}-walkthrough-example`,
        language: "ts",
        code: id === "s_01"
          ? "const token = await tokenStore.get(session.userId)"
          : `await implementStage("${id}")`
      }
    ],
    callPathDiff: id === "s_01"
      ? {
          before: [
            { symbol: "readSession", path: "src/auth/session.ts" },
            { symbol: "MemoryStore.get", path: "src/auth/memory-store.ts" }
          ],
          after: [
            { symbol: "readSession", path: "src/auth/session.ts" },
            { symbol: "TokenStore.get", path: "src/auth/token-store.ts" }
          ]
        }
      : undefined,
    acceptance: acceptance.map((a) => ({
      ...a,
      testReferences: a.testReferences?.map((reference) => ({
        path: reference.path,
        cases: [...reference.cases]
      })) ?? [],
      evidence: null
    })),
    dependencies: [...dependencies],
    complexity
  })
  const stages = [
    stage("s_01", "Audit session middleware", [], "low", [{ path: "src/auth/memory-store.ts", change: "M" }], [{
      id: "s_01.1",
      text: "The current token read path is documented.",
      status: "pending",
      testReferences: [{
        path: "src/auth/session.test.ts",
        cases: ["keeps stage review traceable"]
      }]
    }]),
    stage("s_02", "Create TokenStore module", ["s_01"], "medium", [{ path: "src/auth/token-store.ts", change: "A" }], [{ id: "s_02.1", text: "TokenStore exposes get/set/refresh and is covered by tests.", status: "passed" }]),
    stage("s_03", "Swap MemoryStore to TokenStore", ["s_02"], "medium", [{ path: "src/auth/session.ts", change: "M" }], [{ id: "s_03.1", text: "Session reads route through TokenStore.", status: "pending" }]),
    stage("s_04", "Handle token refresh", ["s_03"], "high", [{ path: "src/auth/refresh.ts", change: "M" }], [{ id: "s_04.1", text: "The refresh decision is specified.", status: "pending" }]),
    stage("s_05", "Update auth tests", ["s_04"], "medium", [{ path: "src/auth/session.test.ts", change: "M" }], [{
      id: "s_05.1",
      text: `Tests cover the store, the 401 retry${rev > 1 ? ", and the requested audit amendment" : ""}.`,
      status: "pending",
      testReferences: [{
        path: "src/auth/session.test.ts",
        cases: ["refreshes once and replays on a 401"]
      }]
    }]),
    stage(
      "s_06",
      "Open PR #482",
      [],
      "low",
      [{ path: "CHANGELOG.md", change: "M" }],
      [{ id: "s_06.1", text: "A PR is opened against main.", status: "pending" }],
      holdWorker
        ? [{ kind: "prose" as const, id: "hold", text: "[[worker-hold]] Wait for an explicit stop before completing the first attempt." }]
        : []
    ),
    ...(includeRoutingStage
      ? [stage(
          "s_routing_medium",
          "Document worker routing telemetry",
          [],
          "medium",
          [{ path: "src/auth/routing-telemetry.ts", change: "A" }],
          [{
            id: "s_routing_medium.1",
            text: "Worker routing telemetry records the effective model.",
            status: "pending",
            testReferences: [{
              path: "src/auth/routing-telemetry.test.ts",
              cases: ["records the effective worker model"]
            }]
          }]
        )]
      : []),
    ...(includeAuditStage
      ? [stage("s_07", "Add independent audit coverage", [], "low", [{ path: "src/auth/audit.test.ts", change: "A" }], [{ id: "s_07.1", text: "Independent audit coverage completes with recorded evidence.", status: "pending" }])]
      : [])
  ]
  return {
    title: `PRD: Refactor auth flow${rev > 1 ? " (revised)" : ""}`,
    sections: [
      {
        id: "tldr",
        title: "TL;DR",
        blocks: [{
          kind: "prose",
          id: "tldr-copy",
          text: "Move token lifecycle behind TokenStore, guard the refresh path, and verify each stage in place."
        }]
      },
      {
        id: "context",
        title: "Context",
        blocks: [{ kind: "prose", id: "c1", text: "Move session token handling into a dedicated TokenStore and add a guarded 401-retry refresh path." }]
      },
      {
        id: "design",
        title: "Technical design",
        blocks: [
          { kind: "prose", id: "d1", text: "Reads route through TokenStore; a 401 triggers a single guarded refresh, then one replay." },
          { kind: "diagram", id: "d2", source: "flowchart TD\n  A[Request] --> B{401?}\n  B -->|yes| C[refresh once]\n  C --> D[replay]\n  B -->|no| D" }
        ]
      }
    ],
    stages,
    annotations: []
  }
}

/** A scripted plan JSON emission block, for the streaming + submission fakes. */
export const scriptedPlanEmission = (
  sessionId: string,
  rev: number,
  holdWorker = false,
  mode: "draft" | "submit" = "submit",
  includeAuditStage = false,
  includeRoutingStage = false
): string =>
  JSON.stringify(
    {
      mode,
      plan: scriptedPlanPrd(
        sessionId,
        rev,
        holdWorker,
        includeAuditStage,
        includeRoutingStage
      )
    },
    null,
    2
  )

/**
 * The scripted run body — a deterministic sequence (thinking, reads, a gated
 * edit, a gated shell command) driving the full contract without a real process.
 * Reused by `makeScriptedAgentTurnDriver` in deterministic tests and Electron
 * e2e. `delayMs` paces the stream.
 *
 * Markers in the prompt drive the interactive flows: `[[ask]]` → AskUserQuestion,
 * `[[plan]]` → propose a plan and honour the approve/revise decision.
 * `[[stream-plan]]` adds cumulative live-only snapshots before that promotion.
 * `[[queue-hold]]` parks a test turn so queue affordances can be exercised
 * without borrowing the plan-approval lifecycle.
 * `[[memory-propose]]` publishes the fixed shared-memory E2E fixture, but only
 * when the built Electron suite explicitly sets `JINGLER_E2E=1`.
 * `[[memory-propose-conflict]]` submits a stale accepted-page revision through
 * the same E2E-only path so the harness-facing conflict remains observable.
 */
const SCRIPTED_MEMORY_PROTOCOL = "2026-07-28"
const SCRIPTED_MEMORY_PROPOSE_MARKER = "[[memory-propose]]"
const SCRIPTED_MEMORY_CONFLICT_MARKER = "[[memory-propose-conflict]]"
const SCRIPTED_MEMORY_MARKDOWN = [
  "# Refund rate limiting",
  "",
  "Refund retries share one team limiter so bursts cannot multiply across workers."
].join("\n")

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const callScriptedMemoryTool = async (
  server: RemoteMcpServer,
  id: string,
  name: "memory_navigation" | "memory_propose" | "memory_workflow_status",
  args: Readonly<Record<string, unknown>>
): Promise<Record<string, unknown> | null> => {
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "content-type": "application/json",
      "mcp-protocol-version": SCRIPTED_MEMORY_PROTOCOL
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    })
  })
  const payload: unknown = await response.json()
  if (!isJsonRecord(payload)) return null
  const result = payload.result
  if (!isJsonRecord(result)) return null
  const structuredContent = result.structuredContent
  if (!isJsonRecord(structuredContent)) return null
  const data = structuredContent.data
  return isJsonRecord(data) ? data : null
}

const scriptedMemoryConflictText = (
  data: Readonly<Record<string, unknown>> | null
): string | null => {
  if (data?.status !== "conflict" || !Array.isArray(data.conflicts)) return null
  const conflict = data.conflicts.find(isJsonRecord)
  if (conflict === undefined) return "Memory proposal conflicted."
  const pageId = typeof conflict.pageId === "string" ? conflict.pageId : "unknown page"
  const expected = typeof conflict.expectedBaseRevisionId === "string"
    ? conflict.expectedBaseRevisionId
    : "unknown base"
  const current = typeof conflict.currentHeadRevisionId === "string"
    ? conflict.currentHeadRevisionId
    : "unknown head"
  return `Memory proposal conflict for ${pageId}: expected ${expected}; current ${current}.`
}

export const scriptedRun =
  (delayMs: number): AgentTurnDriverShape["run"] =>
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

      // Exercise native MCP wiring in the deterministic adapter too. This is
      // deliberately a standard, header-free MCP call through the attachment
      // URL: it proves the harness-facing loopback proxy works end to end while
      // keeping the upstream organization grant in Jingler's main process.
      const memoryServer = spec.mcp?.memory
      if (memoryServer && "url" in memoryServer) {
        yield* Effect.tryPromise({
          try: () =>
            callScriptedMemoryTool(
              memoryServer,
              `scripted-memory-${sessionId}`,
              "memory_navigation",
              {}
            ),
          catch: () => null
        }).pipe(Effect.ignore)

        // An E2E-only proposal marker lets Electron prove the same
        // agent-owned publication path a real harness uses after its silent
        // end-of-turn reflection. Scripted mode alone is NOT a safe boundary:
        // it is also the production fallback when no supported CLI is installed.
        const memoryConflict = spec.prompt.includes(SCRIPTED_MEMORY_CONFLICT_MARKER)
        const memoryProposal = spec.prompt.includes(SCRIPTED_MEMORY_PROPOSE_MARKER)
        if (isE2eEnv() && (memoryProposal || memoryConflict)) {
          const proposalData = yield* Effect.tryPromise({
            try: () => callScriptedMemoryTool(
              memoryServer,
              `scripted-memory-propose-${sessionId}`,
              "memory_propose",
              memoryConflict
                ? {
                    pageId: "alpha",
                    baseRevisionId: "revision:alpha:1",
                    markdown: "# Alpha memory\n\nA stale update must never overwrite revision two."
                  }
                : {
                    pageId: "shared-learning",
                    baseRevisionId: "new",
                    markdown: SCRIPTED_MEMORY_MARKDOWN
                  }
            ),
            catch: () => null
          }).pipe(Effect.catchAll(() => Effect.succeed(null)))

          const conflictText = scriptedMemoryConflictText(proposalData)
          if (conflictText !== null) yield* emit({ _tag: "Assistant", text: conflictText })

          const workflowId = typeof proposalData?.workflowId === "string"
            ? proposalData.workflowId
            : null
          if (workflowId !== null) {
            yield* Effect.tryPromise({
              try: () => callScriptedMemoryTool(
                memoryServer,
                `scripted-memory-workflow-${sessionId}`,
                "memory_workflow_status",
                { workflowId }
              ),
              catch: () => null
            }).pipe(Effect.ignore)
          }
        }
      }

      // A deterministic busy window for queue E2E. Plan approval used to stand
      // in for this, but messages sent against a proposed plan are now revision
      // feedback by design and must never be treated as an ordinary work queue.
      if (spec.prompt.includes("[[queue-hold]]")) {
        yield* emit({ _tag: "Assistant", text: "Holding the active turn for queue actions." })
        yield* Effect.never
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

      // Once a plan is approved, later amendments return the complete revised
      // document inline. Model that contract
      // directly so the runner exercises amendment reconciliation without opening
      // a second approval gate.
      if (spec.prompt.includes("[[amendment]]")) {
        yield* emit({
          _tag: "Thinking",
          text: "Folding the requested audit amendment into the approved plan.",
          seconds: 2,
          done: true
        })
        yield* pause
        yield* emit({ _tag: "Assistant", text: "Folding that in." })
        yield* proposePlan(scriptedPlanPrd(sessionId, 2, false, true))
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[plan]]` marker drives plan mode: propose a plan, then execute on
      // approval or re-propose a revised one on revise (one cycle max, for tests).
      if (
        (spec.prompt.includes("[[plan]]") || spec.mode === "plan")
      ) {
        yield* emit({ _tag: "Thinking", text: "Mapping out the work before touching anything.", seconds: 3, done: true })
        yield* pause
        let rev = spec.prompt.includes("[[amendment]]") ? 2 : 1
        while (true) {
          if (spec.prompt.includes("[[stream-plan]]")) {
            const source = `\`\`\`json\n${scriptedPlanEmission(
              sessionId,
              rev,
              spec.prompt.includes("[[worker-hold]]"),
              "submit",
              false,
              spec.prompt.includes("[[complexity-routing]]")
            )}\n\`\`\``
            const boundaries = [
              Math.floor(source.length * 0.3),
              Math.floor(source.length * 0.6),
              Math.floor(source.length * 0.85),
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
            scriptedPlanPrd(
              sessionId,
              rev,
              spec.prompt.includes("[[worker-hold]]"),
              false,
              spec.prompt.includes("[[complexity-routing]]")
            )
          )
          if (decision._tag === "Approve") {
            yield* emit({ _tag: "Assistant", text: "Plan approved — executing the steps." })
            yield* pause
            const executionPlan = scriptedPlanPrd(
              sessionId,
              rev,
              spec.prompt.includes("[[worker-hold]]"),
              false,
              spec.prompt.includes("[[complexity-routing]]")
            )
            // `[[plan-unknown-stage]]` — the plan-sync loop: emit a checkpoint
            // for a stage the approved plan does not have (the runner drops it
            // and steers a corrective back), then submit the amended plan and
            // let the runner replay the dropped checkpoint against it.
            if (spec.prompt.includes("[[plan-unknown-stage]]")) {
              let corrective: string | null = null
              if (registerTurnSteer !== undefined) {
                // A steer handler MUST NOT call `emit` (see [[held-subagents]]);
                // it only records the text, and the loop below acknowledges it.
                yield* registerTurnSteer((text) => {
                  corrective = text
                  return Promise.resolve("accepted" as const)
                })
              }
              const ghost: PlanPrd["stages"][number] = {
                id: "s_99",
                title: "Hardening follow-up",
                intent: "Hardening follow-up.",
                approach: [],
                tasks: [
                  {
                    id: "s_99.task.1",
                    text: "Harden the refresh path",
                    status: "pending" as const
                  }
                ],
                files: [],
                diagrams: [],
                notes: [],
                acceptance: [
                  {
                    id: "s_99.1",
                    text: "Refresh path hardened",
                    status: "pending" as const,
                    evidence: null
                  }
                ]
              }
              yield* emit({
                _tag: "Assistant",
                text: `Starting the extra hardening work.\nPLAN_TASK stage=${ghost.id} fingerprint=${planTaskProgressFingerprint(ghost)} task=${ghost.tasks![0]!.id} status=completed\n`
              })
              for (let tick = 0; tick < 50 && corrective === null; tick++) {
                yield* Effect.sleep("100 millis")
              }
              yield* emit({
                _tag: "Assistant",
                text:
                  corrective === null
                    ? "No corrective arrived."
                    : `Corrective received: ${corrective}`
              })
              yield* proposePlan({
                ...executionPlan,
                stages: [...executionPlan.stages, ghost]
              })
              yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
              if (registerTurnSteer !== undefined) yield* registerTurnSteer(null)
              return
            }
            // Each edit's path matches a plan step's files, so the runner marks that
            // step done — exercising the execution → plan-progress linkage.
            const edits: ReadonlyArray<{ id: string; path: string; preview: string; diff: { added: number; removed: number } }> = [
              { id: "plan-edit-1", path: "src/auth/token-store.ts", preview: "+export class TokenStore {\n+  // …\n+}", diff: { added: 40, removed: 0 } },
              { id: "plan-edit-2", path: "src/auth/session.ts", preview: "-import { MemoryStore } from \"./memory-store.js\"\n+import { TokenStore } from \"./token-store.js\"", diff: { added: 8, removed: 3 } },
              { id: "plan-edit-3", path: "src/auth/session.test.ts", preview: "+it(\"refreshes once and replays on a 401\", () => {\n+  // …\n+})", diff: { added: 24, removed: 2 } }
            ]
            for (const [editIndex, e] of edits.entries()) {
              yield* emit({ _tag: "ToolStart", id: e.id, name: "Write", target: e.path })
              yield* pause
              yield* emit({ _tag: "ToolEnd", id: e.id, status: "success", meta: null, diff: e.diff, preview: e.preview })
              yield* pause
              if (
                editIndex === 0 &&
                spec.prompt.includes("[[plan-partial-hold]]")
              ) {
                const stage = executionPlan.stages.find(
                  (candidate) => candidate.id === "s_02"
                )!
                for (const task of stage.tasks ?? []) {
                  yield* emit({
                    _tag: "Assistant",
                    text: `PLAN_TASK stage=${stage.id} fingerprint=${planTaskProgressFingerprint(stage)} task=${task.id} status=completed\n`
                  })
                }
                yield* Effect.never
              }
            }
            const evidenceReply = [
              "Steps 2, 3 and 5 are done.",
              ...executionPlan.stages.flatMap((stage) =>
                (stage.tasks ?? []).map(
                  (task) =>
                    `PLAN_TASK stage=${stage.id} fingerprint=${planTaskProgressFingerprint(stage)} task=${task.id} status=completed`
                )
              ),
              ...(spec.prompt.includes("[[plan-needs-verification]]")
                ? []
                : [
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
                  ))
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
          if (decision._tag === "Reject" || rev >= 2) {
            yield* emit({ _tag: "Assistant", text: "Holding here until you're ready." })
            break
          }
          yield* emit({ _tag: "Assistant", text: "Good call — revising the plan to guard the refresh loop." })
          yield* pause
          rev += 1
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

      // One completed mutation for the Files workspace's focused-diff E2E. The
      // fixture changes the real file first; this stream supplies the same tool
      // identity and compact hunk a live harness publishes.
      if (spec.prompt.includes("[[follow-diff-preview]]")) {
        yield* emit({
          _tag: "ToolStart",
          id: "follow-diff-1",
          name: "Edit",
          target: "src/config.ts"
        })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "follow-diff-1",
          status: "success",
          meta: null,
          diff: { added: 1, removed: 1 },
          preview: "-export const mode = 'legacy'\n+export const mode = 'modern'"
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // The fixture performs a real move before this event. Reporting the
      // source path mirrors harnesses that publish the path attached to the
      // original edit tool while the workspace diff carries the destination.
      if (spec.prompt.includes("[[follow-file-move]]")) {
        yield* emit({
          _tag: "ToolStart",
          id: "follow-move-1",
          name: "Edit",
          target: "src/config.ts"
        })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "follow-move-1",
          status: "success",
          meta: null,
          diff: { added: 1, removed: 1 },
          preview: "-export const mode = 'legacy'\n+export const mode = 'modern'"
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      if (spec.prompt.includes("[[expect-code-context]]")) {
        yield* emit({
          _tag: "Assistant",
          text: spec.prompt.includes("<repository-code-references>")
            ? "Received selected diff context."
            : "Selected diff context was missing."
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A nested sub-agent mutation for the Files workspace's opt-in follow
      // coverage. The child is deliberately two levels below the main agent so
      // the Electron test proves follow observes descendants, rather than only
      // the main transcript or direct children.
      if (spec.prompt.includes("[[subagent-edit-preview]]")) {
        const parent = `toolu_parent_${sessionId}`
        const child = `toolu_child_${sessionId}`
        yield* emit({
          _tag: "SubagentStarted",
          id: parent,
          name: "Explore",
          description: "Delegate the file update",
          parentId: null
        })
        yield* emit({
          _tag: "SubagentStarted",
          id: child,
          name: "general-purpose",
          description: "Update the delegated file",
          parentId: parent
        })
        yield* emit({
          _tag: "ToolStart",
          id: "subagent-edit-1",
          name: "Edit",
          target: "src/delegated.ts",
          agentId: child
        })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "subagent-edit-1",
          status: "success",
          meta: null,
          diff: { added: 1, removed: 0 },
          preview: "+export const delegated = true",
          agentId: child
        })
        yield* emit({ _tag: "SubagentEnded", id: child, status: "done" })
        yield* emit({ _tag: "SubagentEnded", id: parent, status: "done" })
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
 * A deterministic driver for unit tests and Electron e2e. `delayMs` paces the
 * stream while the production driver delegates to embedded pi.
 */
export const makeScriptedAgentTurnDriver = (delayMs: number): Layer.Layer<AgentTurnDriver> =>
  Layer.succeed(AgentTurnDriver, AgentTurnDriver.of({ run: scriptedRun(delayMs), stop: () => Effect.void }))

/** The default scripted adapter, paced for a visible streaming cadence. */
export const ScriptedAgentTurnDriverLive = makeScriptedAgentTurnDriver(320)
