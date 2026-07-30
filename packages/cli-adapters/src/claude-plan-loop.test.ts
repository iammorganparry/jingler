import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Plan, StreamEvent } from "@jingler/core"
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

const planHtml = (title: string): string => [
  `\`\`\`\`html`,
  `<h1>PRD: ${title}</h1>`,
  '<section data-stage="01" data-title="Persist the plan">',
  "<h3>Intent</h3><p>Populate Plan Review.</p>",
  '<div data-acceptance="01.1" data-status="pending">Plan Review is populated.</div>',
  "</section>",
  "````"
].join("\n")

let visibleReply = ""
let exitInput: Record<string, unknown> = {}
let exitDecision: unknown = null
let callExitPlanMode = true
let callEnterPlanMode = false
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
        await options.canUseTool(
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
  const proposed: Plan[] = []
  const ctx: AgentContext = {
    emit: (event) => Effect.sync(() => void events.push(event)),
    canUseTool: () => Effect.succeed("allow"),
    askQuestion: () => Effect.succeed([]),
    proposePlan: (plan) =>
      Effect.sync(() => {
        proposed.push(plan)
        return decisions[proposed.length - 1] ?? { _tag: "Reject" }
      }),
    registerBackgroundStop: () => Effect.void
  }
  return { ctx, events, proposed }
}

beforeEach(() => {
  visibleReply = `The complete plan follows.\n\n${planHtml("Buffered plan")}`
  exitInput = {}
  exitDecision = null
  callExitPlanMode = true
  callEnterPlanMode = false
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
    expect(proposed[0]?.summary).toBe("Auto native plan")
    expect(writeDecision).toMatchObject({ behavior: "deny" })
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
    expect(proposed[0]?.summary).toBe("Native plan file")
    expect(writeDecision).toMatchObject({ behavior: "deny" })
  })

  it("uses the streamed inline PRD when Claude ends without calling ExitPlanMode", async () => {
    callExitPlanMode = false
    const { ctx, proposed } = harness()

    await Effect.runPromise(runClaude("session-0", spec, ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(proposed[0]).toMatchObject({
      summary: "Buffered plan",
      structured: true
    })
  })

  it("uses the streamed inline PRD when ExitPlanMode has an empty payload", async () => {
    const { ctx, proposed } = harness()

    await Effect.runPromise(runClaude("session-1", spec, ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(proposed[0]).toMatchObject({
      summary: "Buffered plan",
      structured: true
    })
    expect(proposed[0]?.steps.map((step) => step.id)).toEqual(["01"])
    expect(proposed[0]?.raw).toContain("<h1>PRD: Buffered plan</h1>")
    expect(exitDecision).toMatchObject({ behavior: "deny" })
  })

  it("prefers a valid explicit payload over buffered assistant text", async () => {
    exitInput = { plan: planHtml("Payload plan") }
    const { ctx, proposed } = harness()

    await Effect.runPromise(runClaude("session-2", spec, ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.summary).toBe("Payload plan")
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
    expect(proposed[0]).toMatchObject({
      summary: "Buffered plan",
      structured: true
    })
  })

  it("does not reuse the previous streamed plan after the operator requests a revision", async () => {
    followupReply = ""
    const { ctx, proposed } = harness([
      { _tag: "Revise", feedback: "Address the operator comment." }
    ])

    await Effect.runPromise(runClaude("session-4", spec, ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.summary).toBe("Buffered plan")
    expect(followupDecision).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("not valid Jingler plan HTML")
    })
  })
})
