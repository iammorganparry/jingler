import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  PlanDecision,
  scriptedRun,
  type AgentContext,
  type SessionSpec
} from "./adapter.js"

const spec = (): SessionSpec => ({
  cli: "claude",
  repo: "acme/widget",
  branch: "main",
  cwd: "/tmp/widget",
  prompt: "[[memory-propose]] Remember the reusable limiter.",
  images: [],
  binPath: null,
  mode: "auto",
  model: null,
  resumeId: null,
  remoteMcpServers: [
    {
      name: "jingler-memory",
      url: "http://127.0.0.1:43123/mcp",
      headers: { authorization: "Bearer test-only" }
    }
  ]
})

const context: AgentContext = {
  emit: () => Effect.void,
  canUseTool: () => Effect.succeed("deny"),
  askQuestion: () => Effect.succeed([]),
  proposePlan: () => Effect.succeed(PlanDecision.Reject()),
  registerBackgroundStop: () => Effect.void,
  registerTurnSteer: () => Effect.void
}

interface ToolCall {
  readonly params: {
    readonly name: string
    readonly arguments: Readonly<Record<string, unknown>>
  }
}

const toolCalls = (fetchMock: ReturnType<typeof vi.fn>): ReadonlyArray<ToolCall> =>
  fetchMock.mock.calls.map((call) => {
    const init = call[1] as RequestInit | undefined
    return JSON.parse(String(init?.body)) as ToolCall
  })

const calledToolNames = (fetchMock: ReturnType<typeof vi.fn>): ReadonlyArray<string> =>
  toolCalls(fetchMock).map((call) => call.params.name)

const toolResult = (data: Readonly<Record<string, unknown>>): Response =>
  Response.json({
    jsonrpc: "2.0",
    result: { structuredContent: { data } }
  })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("scripted memory markers", () => {
  it("never publishes a memory marker in the production scripted fallback", async () => {
    vi.stubEnv("JINGLER_E2E", "0")
    const fetchMock = vi.fn(async () => Response.json({ jsonrpc: "2.0", result: {} }))
    vi.stubGlobal("fetch", fetchMock)

    await Effect.runPromise(scriptedRun(0)("session-production", spec(), context))

    expect(calledToolNames(fetchMock)).toEqual(["memory_navigation"])
  })

  it("allows the memory proposal marker only inside Electron E2E", async () => {
    vi.stubEnv("JINGLER_E2E", "1")
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as ToolCall
      return toolResult(
        call.params.name === "memory_propose"
          ? { workflowId: "compiler-proposal", status: "queued" }
          : {}
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await Effect.runPromise(scriptedRun(0)("session-e2e", spec(), context))

    expect(calledToolNames(fetchMock)).toEqual([
      "memory_navigation",
      "memory_propose",
      "memory_workflow_status"
    ])
    expect(toolCalls(fetchMock)[1]?.params.arguments).toEqual({
      pageId: "shared-learning",
      baseRevisionId: "new",
      markdown: "# Refund rate limiting\n\nRefund retries share one team limiter so bursts cannot multiply across workers."
    })
    expect(toolCalls(fetchMock)[2]?.params.arguments).toEqual({
      workflowId: "compiler-proposal"
    })
  })

  it("surfaces a stale memory proposal conflict to the scripted harness", async () => {
    vi.stubEnv("JINGLER_E2E", "1")
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as ToolCall
      return toolResult(
        call.params.name === "memory_propose"
          ? {
              status: "conflict",
              conflicts: [{
                pageId: "alpha",
                expectedBaseRevisionId: "revision:alpha:1",
                currentHeadRevisionId: "revision:alpha:2"
              }]
            }
          : {}
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    const assistant: Array<string> = []
    const conflictContext: AgentContext = {
      ...context,
      emit: (event) => Effect.sync(() => {
        if (event._tag === "Assistant") assistant.push(event.text)
      })
    }

    await Effect.runPromise(scriptedRun(0)(
      "session-conflict",
      { ...spec(), prompt: "[[memory-propose-conflict]] Try a stale update." },
      conflictContext
    ))

    expect(calledToolNames(fetchMock)).toEqual([
      "memory_navigation",
      "memory_propose"
    ])
    expect(assistant).toContain(
      "Memory proposal conflict for alpha: expected revision:alpha:1; current revision:alpha:2."
    )
  })
})
