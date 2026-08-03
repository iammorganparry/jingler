import type { Plan, PlanPrd, QuestionRequest, StreamEvent } from "@jingler/core"
import { planDocumentToPlan } from "@jingler/core"
import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentContext, PlanDecision as PlanDecisionType, SessionSpec } from "./adapter.js"
import { PlanDecision } from "./adapter.js"

/** A structured plan + its JSON emission block, replacing the old HTML+marker fixtures. */
const PLAN: PlanPrd = {
  title: "PRD: Stream the plan",
  sections: [],
  stages: [
    {
      id: "01",
      title: "Draft",
      intent: "Show work as it is composed.",
      approach: [],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "01.1", text: "Draft is visible.", status: "pending", evidence: null }],
      dependencies: []
    }
  ],
  annotations: []
}
const emission = (mode: "draft" | "submit"): string =>
  ["```json", JSON.stringify({ mode, plan: PLAN }), "```"].join("\n")
const SUBMIT_PLAN = emission("submit")
const DRAFT_PLAN = emission("draft")

/**
 * The Codex plan loop, which is the one part of `runCodex` that cannot be
 * covered by the pure ThreadEvent→StreamEvent seam: it spans several harness
 * turns, and its whole job is to react to the operator between them.
 *
 * Codex has no `ExitPlanMode` and no `canUseTool`, so BOTH halves of plan mode
 * happen through the prompt — the plan arrives as a fenced block in an ordinary
 * reply, and the operator's verdict goes back as the next turn's prompt. That
 * makes "what was prompted, in what order, against which sandbox" the entire
 * contract, and none of it is observable from a pure function.
 *
 * The SDK is mocked rather than run because a live Codex turn needs a real
 * ChatGPT login. It is kept in its own file so `codex-adapter.test.ts` stays
 * what it says it is: the pure seam.
 */

// ── The scripted SDK double ──────────────────────────────────────────────────

interface RecordedRun {
  readonly prompt: string
  readonly sandboxMode: string
}

const sdk = vi.hoisted(() => {
  const state = {
    /** Turns to serve, in order: each is the events one `runStreamed` yields. */
    script: [] as Array<ReadonlyArray<unknown>>,
    failures: [] as Array<Error | null>,
    runs: [] as RecordedRun[],
    /** The policy the CURRENT thread handle was opened with. */
    sandboxMode: "",
    resumedWith: [] as string[]
  }

  const makeThread = (options: { sandboxMode?: string }) => {
    state.sandboxMode = options.sandboxMode ?? ""
    return {
      runStreamed: (prompt: string) => {
        state.runs.push({ prompt, sandboxMode: state.sandboxMode })
        const failure = state.failures.shift()
        if (failure !== undefined && failure !== null) return Promise.reject(failure)
        const events = state.script.shift() ?? []
        return Promise.resolve({
          events: (async function* () {
            for (const e of events) yield e
          })()
        })
      }
    }
  }

  class Codex {
    startThread(options: { sandboxMode?: string }) {
      return makeThread(options)
    }
    resumeThread(id: string, options: { sandboxMode?: string }) {
      state.resumedWith.push(id)
      return makeThread(options)
    }
  }

  return { state, Codex }
})

const contextProbe = vi.hoisted(() => ({
  calls: [] as Array<{ binPath: string | null | undefined; threadId: string; signal: AbortSignal | undefined }>
}))

vi.mock("@openai/codex-sdk", () => ({ Codex: sdk.Codex }))
vi.mock("./codex-app-server.js", () => ({
  readCodexContextUsage: (
    binPath: string | null | undefined,
    threadId: string,
    signal?: AbortSignal
  ) => {
    contextProbe.calls.push({ binPath, threadId, signal })
    return Promise.resolve({ tokens: 193_496, window: 258_400 })
  }
}))

// Imported AFTER the mock is registered.
const { runCodexSdk: runCodex } = await import("./codex-adapter.js")

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MIGRATION_PLAN: PlanPrd = {
  title: "Add a tier column",
  sections: [],
  stages: [
    {
      id: "01",
      title: "Add the column",
      intent: "Accounts need a billing tier.",
      approach: ["write the migration"],
      files: [{ path: "migrations/003.sql", change: "A", added: 12, removed: 0 }],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "01.1", text: "The column exists.", status: "pending", evidence: null }],
      dependencies: []
    },
    {
      id: "02",
      title: "Backfill it",
      intent: "Existing rows need a value.",
      approach: ["batch update"],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "02.1", text: "Rows are backfilled.", status: "pending", evidence: null }],
      dependencies: ["01"]
    }
  ],
  annotations: []
}
const PLAN_TEXT = [
  "Here is what I propose.",
  "",
  "```json",
  JSON.stringify({ mode: "submit", plan: MIGRATION_PLAN }),
  "```"
].join("\n")

const QUESTION_TEXT = [
  "```question",
  JSON.stringify({
    questions: [
      {
        question: "Which database?",
        header: "Database",
        multiSelect: false,
        options: [
          { label: "Postgres", description: "Use the existing service." },
          { label: "SQLite", description: "Add a local store." }
        ]
      }
    ]
  }),
  "```"
].join("\n")

const agentMessage = (text: string) => ({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text }
})

const turnDone = { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }

const spec = (over: Partial<SessionSpec> = {}): SessionSpec =>
  ({
    cli: "codex",
    repo: "r",
    branch: "b",
    cwd: process.cwd(),
    prompt: "plan the tier column",
    images: [],
    binPath: "/usr/bin/codex",
    mode: "plan",
    model: null,
    ...over
  }) as SessionSpec

/**
 * Mirror production: when the operator approves, agent-runner threads the
 * canonical `Plan` back on the decision (`{ ...exactPlan, status: "approved" }`),
 * which the adapter turns into the execution-resume prompt. The scripted
 * decisions omit it, so the harness attaches the just-proposed plan.
 */
const prdToPlan = (prd: PlanPrd): Plan =>
  planDocumentToPlan({
    id: "plan_test",
    sessionId: "s",
    producingChatId: "c",
    revision: 1,
    status: "approved",
    plan: prd,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "agent"
  })

const harness = (decisions: ReadonlyArray<PlanDecisionType>) => {
  const emitted: StreamEvent[] = []
  const proposed: PlanPrd[] = []
  const questions: string[] = []
  const drafts: PlanPrd[] = []
  let n = 0
  const ctx: AgentContext = {
    emit: (event: StreamEvent) => Effect.sync(() => void emitted.push(event)),
    canUseTool: () => Effect.succeed({ behavior: "allow" as const }),
    askQuestion: (request: QuestionRequest) =>
      Effect.sync(() => {
        questions.push(request.id)
        return [{ selected: ["Postgres"], other: null }]
      }),
    proposePlan: (plan: PlanPrd) =>
      Effect.sync(() => {
        proposed.push(plan)
        const decision = decisions[n++] ?? PlanDecision.Reject()
        return decision._tag === "Approve" && decision.plan === undefined
          ? PlanDecision.Approve({ mode: decision.mode, plan: prdToPlan(plan) })
          : decision
      }),
    saveDraftPlan: (plan: PlanPrd) => Effect.sync(() => void drafts.push(plan)),
    registerBackgroundStop: () => Effect.void
  } as unknown as AgentContext
  return { ctx, emitted, proposed, questions, drafts }
}

beforeEach(() => {
  sdk.state.script = []
  sdk.state.failures = []
  sdk.state.runs = []
  sdk.state.resumedWith = []
  sdk.state.sandboxMode = ""
  contextProbe.calls = []
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe("the Codex plan loop", () => {
  it("keeps auto tools available while accepting a deliberate orchestrator plan", async () => {
    sdk.state.script = [
      [
        { type: "thread.started", thread_id: "t-auto" },
        agentMessage(SUBMIT_PLAN),
        turnDone
      ]
    ]
    const { ctx, emitted, proposed } = harness([PlanDecision.Delegate()])

    await Effect.runPromise(
      runCodex(
        "s-auto-orchestrator",
        spec({
          mode: "auto",
          orchestrationRoutes: [
            { cli: "codex", models: [{ id: "gpt-5.6-sol", label: "Sol" }] }
          ]
        }),
        ctx,
        new Map()
      )
    )

    expect(proposed).toHaveLength(1)
    expect(sdk.state.runs).toHaveLength(1)
    expect(sdk.state.runs[0]?.sandboxMode).toBe("danger-full-access")
    expect(
      emitted.some(
        (event) =>
          event._tag === "Assistant" && event.text.includes("PRD: Stream the plan")
      )
    ).toBe(false)
  })

  it("mirrors a draft-mode plan into a draft while keeping the reply in chat", async () => {
    sdk.state.script = [[agentMessage(DRAFT_PLAN), turnDone]]
    const { ctx, emitted, proposed, drafts } = harness([])

    await Effect.runPromise(
      runCodex(
        "s-auto-plan-example",
        spec({
          mode: "auto",
          orchestrationRoutes: [
            { cli: "codex", models: [{ id: "gpt-5.6-sol", label: "Sol" }] }
          ]
        }),
        ctx,
        new Map()
      )
    )

    // mode:"draft" — the approval gate stays untouched…
    expect(proposed).toHaveLength(0)
    // …the visible reply still lands in chat…
    expect(emitted).toContainEqual({ _tag: "Assistant", text: DRAFT_PLAN })
    // …and the plan is captured as an iteration draft so Plan Review populates.
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.title).toBe("PRD: Stream the plan")
  })

  it("does not create a draft from an ordinary non-plan reply", async () => {
    sdk.state.script = [[agentMessage("I read the code; no changes needed yet."), turnDone]]
    const { ctx, proposed, drafts } = harness([])

    await Effect.runPromise(
      runCodex(
        "s-auto-no-plan",
        spec({
          mode: "auto",
          orchestrationRoutes: [
            { cli: "codex", models: [{ id: "gpt-5.6-sol", label: "Sol" }] }
          ]
        }),
        ctx,
        new Map()
      )
    )

    expect(proposed).toHaveLength(0)
    expect(drafts).toHaveLength(0)
  })

  it("does not create a draft outside orchestration (a plain direct chat)", async () => {
    sdk.state.script = [[agentMessage(DRAFT_PLAN), turnDone]]
    const { ctx, drafts } = harness([])

    await Effect.runPromise(
      runCodex("s-direct", spec({ mode: "auto" }), ctx, new Map())
    )

    expect(drafts).toHaveLength(0)
  })

  it("asks a malformed auto-mode submission to reformat, then accepts the corrected JSON", async () => {
    const malformed = ["```json", '{ "mode": "submit", "plan": { "title":', "```"].join("\n")
    const corrected = SUBMIT_PLAN
    sdk.state.script = [
      [agentMessage(malformed), turnDone],
      [agentMessage(corrected), turnDone]
    ]
    const { ctx, proposed } = harness([PlanDecision.Reject()])

    await Effect.runPromise(
      runCodex(
        "s-auto-plan-reformat",
        spec({
          mode: "auto",
          orchestrationRoutes: [
            { cli: "codex", models: [{ id: "gpt-5.6-sol", label: "Sol" }] }
          ]
        }),
        ctx,
        new Map()
      )
    )

    expect(sdk.state.runs).toHaveLength(2)
    expect(sdk.state.runs[1]?.prompt).toContain("json")
    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.title).toBe("PRD: Stream the plan")
  })

  it("leaves an approved-plan amendment in the reply channel without reopening approval", async () => {
    sdk.state.script = [
      [
        { type: "thread.started", thread_id: "t-approved" },
        agentMessage(SUBMIT_PLAN),
        turnDone
      ]
    ]
    const { ctx, emitted, proposed } = harness([])

    await Effect.runPromise(
      runCodex(
        "s-approved-orchestrator",
        spec({
          mode: "auto",
          orchestrationPlanApproved: true,
          orchestrationRoutes: [
            { cli: "codex", models: [{ id: "gpt-5.6-sol", label: "Sol" }] }
          ]
        }),
        ctx,
        new Map()
      )
    )

    expect(proposed).toHaveLength(0)
    expect(
      emitted.some(
        (event) =>
          event._tag === "Assistant" && event.text.includes("PRD: Stream the plan")
      )
    ).toBe(true)
  })

  it("publishes the completed SDK message through the progressive draft contract", async () => {
    sdk.state.script = [[agentMessage(SUBMIT_PLAN), turnDone]]
    const { ctx, emitted, proposed } = harness([PlanDecision.Reject()])

    await Effect.runPromise(runCodex("s-draft", spec(), ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(emitted).toContainEqual({
      _tag: "PlanDraft",
      draft: {
        id: "plan_s-draft_1",
        source: expect.stringContaining('"PRD: Stream the plan"'),
        phase: "complete"
      }
    })
  })

  it("replaces a resumed thread whose local rollout no longer exists", async () => {
    sdk.state.failures = [
      new Error(
        "Codex Exec exited with code 1: thread/resume failed: no rollout found for thread id stale-thread (code -32600)"
      ),
      null
    ]
    sdk.state.script = [
      [
        { type: "thread.started", thread_id: "replacement-thread" },
        agentMessage("Recovered."),
        turnDone
      ]
    ]
    const resume = new Map<string, string>()
    const { ctx, emitted } = harness([])

    await Effect.runPromise(
      runCodex(
        "s1",
        spec({
          mode: "accept-edits",
          prompt: "inspect the repository",
          resumeId: "stale-thread"
        }),
        ctx,
        resume
      )
    )

    expect(sdk.state.runs.map((run) => run.prompt)).toStrictEqual([
      "inspect the repository",
      "inspect the repository"
    ])
    expect(sdk.state.resumedWith).toStrictEqual(["stale-thread"])
    expect(resume.get("s1")).toBe("replacement-thread")
    expect(emitted).toContainEqual({
      _tag: "Started",
      sessionId: "replacement-thread"
    })
  })

  it("does not replace a resumed thread after an unrelated error", async () => {
    sdk.state.failures = [new Error("thread/resume failed: permission denied")]
    const { ctx } = harness([])

    await expect(
      Effect.runPromise(
        runCodex(
          "s1",
          spec({ mode: "accept-edits", resumeId: "thread-1" }),
          ctx,
          new Map()
        )
      )
    ).rejects.toThrow("permission denied")

    expect(sdk.state.runs).toHaveLength(1)
    expect(sdk.state.resumedWith).toStrictEqual(["thread-1"])
  })

  it("attempts at most one replacement thread", async () => {
    const missing = new Error(
      "thread/resume failed: no rollout found for thread id stale-thread (code -32600)"
    )
    sdk.state.failures = [missing, missing]
    const { ctx } = harness([])

    await expect(
      Effect.runPromise(
        runCodex(
          "s1",
          spec({ mode: "accept-edits", resumeId: "stale-thread" }),
          ctx,
          new Map()
        )
      )
    ).rejects.toThrow("no rollout found")

    expect(sdk.state.runs).toHaveLength(2)
  })

  it("plans read-only, then executes with write access once approved", async () => {
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone],
      [agentMessage("Done — migration written."), turnDone]
    ]
    const { ctx, proposed, emitted } = harness([PlanDecision.Approve({ mode: "accept-edits" })])

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    expect(proposed.map((p) => p.title)).toEqual(["Add a tier column"])
    expect(proposed[0]!.stages.map((s) => s.id)).toEqual(["01", "02"])
    // The point of the whole change: planning cannot write, execution can.
    expect(sdk.state.runs.map((r) => r.sandboxMode)).toEqual(["read-only", "workspace-write"])
    // Same thread id, so the agent does not re-derive what it just worked out.
    expect(sdk.state.resumedWith).toEqual(["t1"])
    // The approved plan is restated, because a re-opened thread is a new turn.
    expect(sdk.state.runs[1]!.prompt).toContain("Add a tier column")
    expect(emitted.some((e) => e._tag === "Done")).toBe(true)
    // The planning reply queued an execution follow-up. Replaying the whole
    // thread between them would add probe latency to an unfinished turn.
    expect(contextProbe.calls).toHaveLength(1)
    expect(contextProbe.calls[0]).toMatchObject({
      binPath: "/usr/bin/codex",
      threadId: "t1"
    })
    expect(contextProbe.calls[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it("sends the operator's comments back as the next prompt on revise", async () => {
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone],
      [agentMessage(PLAN_TEXT), turnDone],
      [agentMessage("Done."), turnDone]
    ]
    const { ctx, proposed } = harness([
      PlanDecision.Revise({ feedback: "step 02 backfills a column step 01 creates" }),
      PlanDecision.Approve({ mode: "auto" })
    ])

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    expect(sdk.state.runs[1]!.prompt).toContain("backfills a column step 01 creates")
    // Revision stays read-only — only approval widens the sandbox.
    expect(sdk.state.runs.map((r) => r.sandboxMode)).toEqual([
      "read-only",
      "read-only",
      "danger-full-access"
    ])
    // Two proposals — the second renders as a revision (PlanStore assigns ids).
    expect(proposed).toHaveLength(2)
    // Two intermediate plan rounds, one final execution round, one probe.
    expect(contextProbe.calls).toHaveLength(1)
  })

  it("ends the turn on reject without re-prompting", async () => {
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone]
    ]
    const { ctx } = harness([PlanDecision.Reject()])

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    expect(sdk.state.runs).toHaveLength(1)
    expect(sdk.state.resumedWith).toEqual([])
  })

  it("does not swallow the plan block as prose", async () => {
    // The Plan card renders the whole message, fence and markdown alike. Emitting
    // it as Assistant text too would show the operator the same plan twice, once
    // reviewable and once not.
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone],
      [agentMessage("Done."), turnDone]
    ]
    const { ctx, emitted, proposed } = harness([PlanDecision.Approve({ mode: "ask" })])

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    const assistant = emitted.filter((e) => e._tag === "Assistant")
    // The captured JSON block is not echoed as chat…
    expect(assistant.some((e) => "text" in e && e.text.includes("```json"))).toBe(false)
    // …and the plan Jingler captured is the migration plan.
    expect(proposed[0]!.title).toBe("Add a tier column")
  })

  it("ignores a plan block outside plan mode", async () => {
    // An agent quoting a plan during ordinary work is not proposing one. Without
    // the mode guard, pasting a plan into a normal turn would park the run on an
    // approval the operator never asked for.
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone]
    ]
    const { ctx, proposed, emitted } = harness([])

    await Effect.runPromise(runCodex("s1", spec({ mode: "accept-edits" }), ctx, new Map()))

    expect(proposed).toEqual([])
    expect(emitted.some((e) => e._tag === "Assistant")).toBe(true)
  })

  it("does not probe context for a one-shot fresh thread", async () => {
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage("Reviewed."), turnDone]
    ]
    const { ctx } = harness([])

    await Effect.runPromise(
      runCodex("review_1", spec({ mode: "ask", fresh: true, readOnly: true }), ctx, new Map())
    )

    expect(contextProbe.calls).toEqual([])
  })

  it("degrades to plain text once the round cap is spent", async () => {
    // Six revisions is an operator reviewing; a seventh is a model that cannot
    // converge. Past the cap the block stays in the reply — no card, no error,
    // exactly what happened before this channel existed.
    const revise = PlanDecision.Revise({ feedback: "again" })
    sdk.state.script = Array.from({ length: 8 }, (_, i) =>
      i === 0
        ? [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone]
        : [agentMessage(PLAN_TEXT), turnDone]
    )
    const { ctx, proposed, emitted } = harness(Array.from({ length: 8 }, () => revise))

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    expect(proposed).toHaveLength(6)
    expect(emitted.some((e) => e._tag === "Assistant" && "text" in e && e.text.includes("```json"))).toBe(true)
  })

  it("keeps the question budget independent from plan revisions", async () => {
    const revise = PlanDecision.Revise({ feedback: "revise again" })
    sdk.state.script = [
      [{ type: "thread.started", thread_id: "t1" }, agentMessage(PLAN_TEXT), turnDone],
      [agentMessage(PLAN_TEXT), turnDone],
      [agentMessage(PLAN_TEXT), turnDone],
      [agentMessage(PLAN_TEXT), turnDone],
      [agentMessage(QUESTION_TEXT), turnDone],
      [agentMessage("Done."), turnDone]
    ]
    const { ctx, questions } = harness([revise, revise, revise, revise])

    await Effect.runPromise(runCodex("s1", spec(), ctx, new Map()))

    expect(questions).toStrictEqual(["q_s1_0"])
    expect(sdk.state.runs[5]!.prompt).toContain("Database: Postgres")
  })
})
