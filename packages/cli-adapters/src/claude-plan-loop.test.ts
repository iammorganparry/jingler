import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type PlanPrd,
  type StreamEvent,
  type WorkerRoutingConfig
} from "@jingler/core"
import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentContext, SessionSpec } from "./adapter.js"

/**
 * Regression for signal-position-ms7r9fpb.
 *
 * Claude streamed a complete fenced PRD into the assistant reply, then called
 * ExitPlanMode with an empty input object. Jingler read only `input.plan`,
 * proposed an empty unstructured fallback, and never wrote current-plan.html.
 * This mock pins the real loop ordering: the text delta is consumed before the
 * SDK asks canUseTool to authorize ExitPlanMode.
 */

/** A plan as its fenced JSON emission (replaces the former HTML fixture). */
const planPrd = (title: string): PlanPrd => ({
  title: `PRD: ${title}`,
  sections: [],
  stages: [
    {
      id: "01",
      title: "Persist the plan",
      intent: "Populate Plan Review.",
      approach: [],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "01.1", text: "Plan Review is populated.", status: "pending", evidence: null }],
      dependencies: []
    }
  ],
  annotations: []
})
const planHtml = (title: string, mode: "draft" | "submit" = "submit"): string =>
  ["```json", JSON.stringify({ mode, plan: planPrd(title) }), "```"].join("\n")

const routedStreamedPlan: PlanPrd = {
  title: "PRD: Routed streamed plan",
  sections: [],
  stages: [
    {
      id: "05",
      title: "Pricing",
      intent: "Pricing work.",
      approach: [],
      files: [{ path: "src/pricing.ts", change: "M" }],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "05.1", text: "Pricing works.", status: "pending", evidence: null }],
      dependencies: [],
      complexity: "high"
    },
    {
      id: "06",
      title: "Packaging",
      intent: "Packaging work.",
      approach: [],
      files: [{ path: "src/packaging.ts", change: "M" }],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "06.1", text: "Packaging works.", status: "pending", evidence: null }],
      dependencies: [],
      complexity: "high"
    }
  ],
  annotations: []
}
const repeatedAgentPlanHtml = ["```json", JSON.stringify({ mode: "submit", plan: routedStreamedPlan }), "```"].join("\n")

const workerRouting: WorkerRoutingConfig = {
  default: { cli: "codex", model: "gpt-5" },
  low: { cli: "codex", model: "gpt-5" },
  medium: { cli: "codex", model: "gpt-5" },
  high: { cli: "claude", model: "opus" }
}

let visibleReply = ""
let exitInput: Record<string, unknown> = {}
let exitDecision: unknown = null
let callExitPlanMode = true
let callEnterPlanMode = false
let enterDecision: unknown = null
let writeInput: Record<string, unknown> | null = null
let writeDecision: unknown = null
let disallowedTools: ReadonlyArray<string> = []
let followupReply: string | null = null
let followupInput: Record<string, unknown> = {}
let followupDecision: unknown = null

interface QueryArgs {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly options: {
    readonly disallowedTools?: ReadonlyArray<string>
    readonly canUseTool: (
      name: string,
      input: Record<string, unknown>,
      options: { readonly toolUseID: string }
    ) => Promise<unknown>
  }
}

const textDelta = (text: string): SDKMessage => ({
  type: "stream_event",
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-000000000001",
  session_id: "claude-plan-session",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text }
  }
})

const result: SDKMessage = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  result: "",
  stop_reason: null,
  total_cost_usd: 0,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0
    },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: "test",
    iterations: [],
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0
    },
    service_tier: "standard",
    speed: "standard"
  },
  modelUsage: {},
  permission_denials: [],
  uuid: "00000000-0000-4000-8000-000000000002",
  session_id: "claude-plan-session"
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: QueryArgs) => ({
    async *[Symbol.asyncIterator]() {
      disallowedTools = options.disallowedTools ?? []
      const drained = (async () => {
        for await (const _message of prompt) {
          // Keep the streaming input alive until runClaude closes it at result.
        }
      })()
      yield textDelta(visibleReply)
      if (callEnterPlanMode) {
        enterDecision = await options.canUseTool(
          "EnterPlanMode",
          {},
          { toolUseID: "enter-plan-1" }
        )
      }
      if (writeInput !== null) {
        writeDecision = await options.canUseTool(
          "Write",
          writeInput,
          { toolUseID: "write-plan-1" }
        )
      }
      if (callExitPlanMode) {
        exitDecision = await options.canUseTool(
          "ExitPlanMode",
          exitInput,
          { toolUseID: "exit-plan-1" }
        )
      }
      if (followupReply !== null) {
        yield textDelta(followupReply)
        followupDecision = await options.canUseTool(
          "ExitPlanMode",
          followupInput,
          { toolUseID: "exit-plan-2" }
        )
      }
      yield result
      await drained
    },
    interrupt: async () => {},
    setPermissionMode: async () => {}
  })
}))

const { runClaude } = await import("./claude-adapter.js")

const spec: SessionSpec = {
  cli: "claude",
  repo: "widget",
  branch: "jingler/plan",
  cwd: process.cwd(),
  prompt: "Plan the fix.",
  images: [],
  binPath: null,
  mode: "plan",
  model: null,
  resumeId: null,
  readOnly: true,
  orchestrationRoutes: []
}

const harness = (
  decisions: ReadonlyArray<
    { readonly _tag: "Approve"; readonly mode: "auto" } |
    { readonly _tag: "Revise"; readonly feedback: string } |
    { readonly _tag: "Reject" }
  > = [{ _tag: "Reject" }]
) => {
  const events: StreamEvent[] = []
  const proposed: PlanPrd[] = []
  const drafts: PlanPrd[] = []
  const ctx: AgentContext = {
    emit: (event) => Effect.sync(() => void events.push(event)),
    canUseTool: () => Effect.succeed("allow"),
    askQuestion: () => Effect.succeed([]),
    proposePlan: (plan) =>
      Effect.sync(() => {
        proposed.push(plan)
        return decisions[proposed.length - 1] ?? { _tag: "Reject" }
      }),
    saveDraftPlan: (plan: PlanPrd) => Effect.sync(() => void drafts.push(plan)),
    registerBackgroundStop: () => Effect.void
  }
  return { ctx, events, proposed, drafts }
}

beforeEach(() => {
  visibleReply = `The complete plan follows.\n\n${planHtml("Buffered plan")}`
  exitInput = {}
  exitDecision = null
  callExitPlanMode = true
  callEnterPlanMode = false
  enterDecision = null
  writeInput = null
  writeDecision = null
  disallowedTools = []
  followupReply = null
  followupInput = {}
  followupDecision = null
})

describe("Claude plan submission", () => {
  it("captures a native plan-file Write after Auto enters plan mode mid-turn", async () => {
    callEnterPlanMode = true
    callExitPlanMode = false
    writeInput = {
      file_path: "/Users/test/.claude/plans/widget.md",
      content: planHtml("Auto native plan")
    }
    const { ctx, proposed } = harness()

    await Effect.runPromise(
      runClaude(
        "session-auto-write",
        { ...spec, mode: "auto" },
        ctx,
        new Map()
      )
    )

    expect(disallowedTools).not.toContain("Write")
    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.title).toBe("PRD: Auto native plan")
    expect(writeDecision).toMatchObject({ behavior: "deny" })
  })

  it("refuses to reopen native plan mode after the orchestrator plan is approved", async () => {
    visibleReply = "Coordinating the approved work."
    callEnterPlanMode = true
    const { ctx, proposed } = harness()

    await Effect.runPromise(
      runClaude(
        "session-approved",
        {
          ...spec,
          mode: "auto",
          readOnly: undefined,
          orchestrationPlanApproved: true
        },
        ctx,
        new Map()
      )
    )

    expect(proposed).toHaveLength(0)
    expect(enterDecision).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("without another approval gate")
    })
    expect(exitDecision).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("without another approval gate")
    })
  })

  it("captures a structured native plan-file Write without allowing the filesystem edit", async () => {
    visibleReply = "Writing the completed plan."
    writeInput = {
      file_path: "/Users/test/.claude/plans/widget.md",
      content: planHtml("Native plan file")
    }
    callExitPlanMode = false
    const { ctx, proposed } = harness()

    await Effect.runPromise(runClaude("session-write", spec, ctx, new Map()))

    expect(disallowedTools).not.toContain("Write")
    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.title).toBe("PRD: Native plan file")
    expect(writeDecision).toMatchObject({ behavior: "deny" })
  })

  it("uses the streamed inline PRD when Claude ends without calling ExitPlanMode", async () => {
    callExitPlanMode = false
    const { ctx, proposed } = harness()

    await Effect.runPromise(runClaude("session-0", spec, ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.title).toBe("PRD: Buffered plan")
  })

  it("uses the streamed inline PRD when ExitPlanMode has an empty payload", async () => {
    const { ctx, events, proposed } = harness()

    await Effect.runPromise(runClaude("session-1", spec, ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.title).toBe("PRD: Buffered plan")
    expect(proposed[0]?.stages.map((stage) => stage.id)).toEqual(["01"])
    expect(proposed[0]?.title).toBe("PRD: Buffered plan")
    expect(events).toContainEqual({
      _tag: "PlanDraft",
      draft: {
        id: "plan_session-1_1",
        source: expect.stringContaining('"PRD: Buffered plan"'),
        phase: "complete"
      }
    })
    expect(exitDecision).toMatchObject({ behavior: "deny" })
  })

  it("leaves ordinary assistant HTML in the transcript without opening a draft", async () => {
    visibleReply = "Here is HTML:\n\n````html\n<h1>Example only</h1>\n````"
    callExitPlanMode = false
    const { ctx, events } = harness()

    await Effect.runPromise(runClaude("session-example", spec, ctx, new Map()))

    expect(events.some((event) => event._tag === "PlanDraft")).toBe(false)
    expect(events).toContainEqual({
      _tag: "Assistant",
      text: visibleReply
    })
  })

  it("mirrors an Auto orchestrator's unmarked plan into a draft without native plan mode", async () => {
    // The reported bug: an Auto (not native-plan) orchestrator streams a plan in
    // an ordinary three-backtick block and never calls ExitPlanMode, so Plan
    // Review stayed empty. It must now become a draft — no approval gate.
    const shownPlan = `Here's the plan for review:\n\n${planHtml("Onboarding perf", "draft")}`
    visibleReply = shownPlan
    callExitPlanMode = false
    const { ctx, events, proposed, drafts } = harness()

    await Effect.runPromise(
      runClaude(
        "session-auto-draft",
        {
          ...spec,
          mode: "auto",
          readOnly: undefined,
          orchestrationRoutes: [
            { cli: "claude", models: [{ id: "opus", label: "Opus" }] }
          ]
        },
        ctx,
        new Map()
      )
    )

    // Not a delegation submission — the approval gate is untouched…
    expect(proposed).toHaveLength(0)
    // …the plan is captured as an iteration draft so Plan Review populates…
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.title).toBe("PRD: Onboarding perf")
    // …and the visible reply still shows in chat.
    expect(events).toContainEqual({ _tag: "Assistant", text: shownPlan })
  })

  it("submits (not drafts) an Auto orchestrator plan carrying the delegation marker", async () => {
    visibleReply = planHtml("Marked plan")
    callExitPlanMode = false
    const { ctx, proposed, drafts } = harness([{ _tag: "Reject" }])

    await Effect.runPromise(
      runClaude(
        "session-auto-marked",
        {
          ...spec,
          mode: "auto",
          readOnly: undefined,
          orchestrationRoutes: [
            { cli: "claude", models: [{ id: "opus", label: "Opus" }] }
          ]
        },
        ctx,
        new Map()
      )
    )

    // The marker routes to the blocking approval gate, not the draft path.
    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.title).toBe("PRD: Marked plan")
    expect(drafts).toHaveLength(0)
  })

  it("discards planner worker ids before proposing a compiled orchestrator PRD", async () => {
    visibleReply = repeatedAgentPlanHtml
    const { ctx, proposed } = harness()

    await Effect.runPromise(
      runClaude(
        "session-routed-stream",
        { ...spec, workerRouting },
        ctx,
        new Map()
      )
    )

    expect(proposed).toHaveLength(1)
    // The adapter passes the decoded plan through; worker routing is applied
    // later in agent-runner's proposePlan (covered by plan-execution tests).
    expect(proposed[0]?.title).toBe("PRD: Routed streamed plan")
    expect(proposed[0]?.stages.map((stage) => stage.id)).toStrictEqual(["05", "06"])
  })

  it("prefers a valid explicit payload over buffered assistant text", async () => {
    exitInput = { plan: planHtml("Payload plan") }
    const { ctx, proposed } = harness()

    await Effect.runPromise(runClaude("session-2", spec, ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.title).toBe("PRD: Payload plan")
  })

  it("prefers a structured streamed PRD over a complete but invalid explicit fence", async () => {
    exitInput = {
      plan: [
        "````html",
        "<h1>PRD: Incomplete payload</h1>",
        "<p>No stage or acceptance criteria.</p>",
        "````"
      ].join("\n")
    }
    const { ctx, proposed } = harness()

    await Effect.runPromise(runClaude("session-3", spec, ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.title).toBe("PRD: Buffered plan")
  })

  it("does not reuse the previous streamed plan after the operator requests a revision", async () => {
    followupReply = ""
    const { ctx, proposed } = harness([
      { _tag: "Revise", feedback: "Address the operator comment." }
    ])

    await Effect.runPromise(runClaude("session-4", spec, ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.title).toBe("PRD: Buffered plan")
    expect(followupDecision).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("json emission")
    })
  })
})
