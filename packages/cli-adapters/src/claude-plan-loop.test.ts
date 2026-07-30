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

interface QueryArgs {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly options: {
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
      const drained = (async () => {
        for await (const _message of prompt) {
          // Keep the streaming input alive until runClaude closes it at result.
        }
      })()
      yield textDelta(visibleReply)
      exitDecision = await options.canUseTool(
        "ExitPlanMode",
        exitInput,
        { toolUseID: "exit-plan-1" }
      )
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
  readOnly: true
}

const harness = () => {
  const events: StreamEvent[] = []
  const proposed: Plan[] = []
  const ctx: AgentContext = {
    emit: (event) => Effect.sync(() => void events.push(event)),
    canUseTool: () => Effect.succeed("allow"),
    askQuestion: () => Effect.succeed([]),
    proposePlan: (plan) =>
      Effect.sync(() => {
        proposed.push(plan)
        return { _tag: "Reject" }
      }),
    registerBackgroundStop: () => Effect.void
  }
  return { ctx, events, proposed }
}

beforeEach(() => {
  visibleReply = `The complete plan follows.\n\n${planHtml("Buffered plan")}`
  exitInput = {}
  exitDecision = null
})

describe("Claude plan submission", () => {
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
})
