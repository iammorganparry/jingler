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

const calledToolNames = (fetchMock: ReturnType<typeof vi.fn>): ReadonlyArray<string> =>
  fetchMock.mock.calls.map((call) => {
    const init = call[1] as RequestInit | undefined
    const body = JSON.parse(String(init?.body)) as {
      readonly params: { readonly name: string }
    }
    return body.params.name
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
    const fetchMock = vi.fn(async () => Response.json({ jsonrpc: "2.0", result: {} }))
    vi.stubGlobal("fetch", fetchMock)

    await Effect.runPromise(scriptedRun(0)("session-e2e", spec(), context))

    expect(calledToolNames(fetchMock)).toEqual([
      "memory_navigation",
      "memory_propose"
    ])
  })
})
