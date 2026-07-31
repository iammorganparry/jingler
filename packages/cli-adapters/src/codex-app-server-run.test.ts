import type { Plan, QuestionRequest, StreamEvent } from "@jingler/core"
import { Effect, Fiber } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentContext, PlanDecision as PlanDecisionType, SessionSpec } from "./adapter.js"
import { PlanDecision } from "./adapter.js"
import type { StartCodexAppServerOptions } from "./codex-app-server-client.js"

const server = vi.hoisted(() => {
  const launches: StartCodexAppServerOptions[] = []
  const state = {
    messages: [] as Array<Record<string, unknown>>,
    replay: [] as Array<Record<string, unknown>>,
    delayedReplay: [] as Array<Record<string, unknown>>,
    requests: [] as Array<{
      method: string
      params: unknown
      options?: { timeoutMs?: number }
    }>,
    responses: [] as Array<{ id: number | string; result: unknown }>,
    diagnostics: [] as Array<{
      event: string
      fields: Readonly<Record<string, unknown>>
    }>,
    threadId: "thread-1",
    resumeError: null as Error | null,
    turnNumber: 0,
    hangMessages: false,
    pendingMessageResolver: null as ((message: Record<string, unknown> | null) => void) | null,
    autoCompleteCompaction: true,
    compactionNumber: 0,
    turnSteer: null as import("./adapter.js").SteerTurn | null,
    diagnosticsCloseCount: 0,
    closed: false,
    launches
  }
  const connection = {
    request: (method: string, params: unknown, options?: { timeoutMs?: number }) => {
      state.requests.push({ method, params, ...(options ? { options } : {}) })
      if (method === "thread/resume" && state.resumeError !== null) {
        const error = state.resumeError
        state.resumeError = null
        return Promise.reject(error)
      }
      if (method === "thread/start" || method === "thread/resume") {
        return Promise.resolve({ thread: { id: state.threadId } })
      }
      if (method === "turn/start") {
        state.turnNumber += 1
        return Promise.resolve({ turn: { id: `turn-${state.turnNumber}` } })
      }
      if (method === "turn/steer") {
        return Promise.resolve({ turnId: `turn-${state.turnNumber}` })
      }
      if (method === "thread/compact/start") {
        state.compactionNumber += 1
        if (state.autoCompleteCompaction) {
          state.messages.unshift(
            {
              method: "turn/started",
              params: {
                threadId: state.threadId,
                turn: {
                  id: `compact-${state.compactionNumber}`,
                  status: "inProgress"
                }
              }
            },
            {
              method: "turn/completed",
              params: {
                threadId: state.threadId,
                turn: {
                  id: `compact-${state.compactionNumber}`,
                  status: "completed",
                  error: null
                }
              }
            }
          )
        }
      }
      return Promise.resolve({})
    },
    notify: vi.fn(),
    diagnosticsPath: "/tmp/codex-app-server-test.jsonl",
    recordDiagnostic: (event: string, fields: Readonly<Record<string, unknown>> = {}) => {
      state.diagnostics.push({ event, fields })
    },
    respond: (id: number | string, result: unknown) => {
      state.responses.push({ id, result })
    },
    respondError: vi.fn(),
    nextMessage: () =>
      state.hangMessages
        ? new Promise<Record<string, unknown> | null>((resolve) => {
            state.pendingMessageResolver = resolve
          })
        : Promise.resolve(state.messages.shift() ?? null),
    nextMessageWithin: () => Promise.resolve(state.delayedReplay.shift() ?? null),
    drainMessages: () => state.replay.splice(0),
    close: () => {
      state.closed = true
      state.pendingMessageResolver?.(null)
      state.pendingMessageResolver = null
    }
  }
  return { state, connection }
})

vi.mock("./codex-app-server-client.js", () => ({
  startCodexAppServer: (options: StartCodexAppServerOptions) => {
    server.state.launches.push(options)
    return Promise.resolve(server.connection)
  }
}))

vi.mock("./codex-app-server-diagnostics.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./codex-app-server-diagnostics.js")>()
  return {
    ...original,
    createCodexAppServerDiagnostics: (directory: string | undefined) =>
      directory === undefined
        ? null
        : {
            path: "/tmp/codex-app-server-test.jsonl",
            record: (event: string, fields: Readonly<Record<string, unknown>> = {}) => {
              server.state.diagnostics.push({ event, fields })
            },
            close: () => {
              server.state.diagnosticsCloseCount += 1
            }
          }
  }
})

const { mapCodexAppServerReasoning, runCodexAppServer } = await import("./codex-app-server-run.js")

const spec = (over: Partial<SessionSpec> = {}): SessionSpec =>
  ({
    cli: "codex",
    repo: "r",
    branch: "b",
    cwd: process.cwd(),
    prompt: "inspect the repository",
    images: [],
    binPath: "/usr/bin/codex",
    mode: "accept-edits",
    model: "gpt-5.6-sol",
    resumeId: null,
    ...over
  }) as SessionSpec

const harness = (decision: PlanDecisionType = PlanDecision.Reject()) => {
  const emitted: StreamEvent[] = []
  const proposed: Plan[] = []
  const asked: QuestionRequest[] = []
  const ctx: AgentContext = {
    emit: (event) => Effect.sync(() => void emitted.push(event)),
    canUseTool: () => Effect.succeed("allow"),
    askQuestion: (request) =>
      Effect.sync(() => {
        asked.push(request)
        return [{ selected: ["Postgres"], other: null }]
      }),
    proposePlan: (plan) =>
      Effect.sync(() => {
        proposed.push(plan)
        return decision
      }),
    registerBackgroundStop: () => Effect.void,
    registerTurnSteer: (steer) =>
      Effect.sync(() => {
        server.state.turnSteer = steer
      })
  }
  return { ctx, emitted, proposed, asked }
}

beforeEach(() => {
  server.state.messages = []
  server.state.replay = []
  server.state.delayedReplay = []
  server.state.requests = []
  server.state.responses = []
  server.state.diagnostics = []
  server.state.threadId = "thread-1"
  server.state.resumeError = null
  server.state.turnNumber = 0
  server.state.hangMessages = false
  server.state.pendingMessageResolver = null
  server.state.autoCompleteCompaction = true
  server.state.compactionNumber = 0
  server.state.turnSteer = null
  server.state.diagnosticsCloseCount = 0
  server.state.closed = false
  server.state.launches = []
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("runCodexAppServer", () => {
  it("passes every normalized remote MCP attachment to app-server startup", async () => {
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx } = harness()

    await Effect.runPromise(
      runCodexAppServer(
        "s1",
        spec({
          remoteMcpServers: [
            {
              name: "open-connector",
              url: "https://connector.example/mcp",
              headers: { Authorization: "Bearer connector-token" }
            },
            {
              name: "jingler-browser",
              url: "http://127.0.0.1:32123/mcp",
              headers: { Authorization: "Bearer preview-token" },
              headerEnvironment: {
                Authorization: "JINGLER_BROWSER_MCP_AUTHORIZATION"
              }
            }
          ]
        }),
        ctx,
        new Map()
      )
    )

    expect(server.state.launches).toHaveLength(1)
    expect(server.state.launches[0]?.configOverrides).toStrictEqual([
      'mcp_servers.open-connector.url="https://connector.example/mcp"',
      'mcp_servers.open-connector.http_headers.Authorization="Bearer connector-token"',
      'mcp_servers.jingler-browser.url="http://127.0.0.1:32123/mcp"',
      'mcp_servers.jingler-browser.env_http_headers.Authorization="JINGLER_BROWSER_MCP_AUTHORIZATION"',
      'shell_environment_policy.filters.JINGLER_BROWSER_MCP_AUTHORIZATION="exclude"'
    ])
    expect(server.state.launches[0]?.configOverrides?.join(" ")).not.toContain(
      "preview-token"
    )
    expect(
      server.state.launches[0]?.env?.JINGLER_BROWSER_MCP_AUTHORIZATION
    ).toBe("Bearer preview-token")
  })

  it("replaces a persisted thread whose local rollout no longer exists", async () => {
    vi.stubEnv("JINGLER_CODEX_DIAGNOSTICS_DIR", "/tmp")
    server.state.threadId = "replacement-thread"
    server.state.resumeError = new Error(
      "thread/resume failed: no rollout found for thread id stale-thread (code -32600)"
    )
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "replacement-thread",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const resume = new Map<string, string>()
    const { ctx, emitted } = harness()

    await Effect.runPromise(
      runCodexAppServer("s1", spec({ resumeId: "stale-thread" }), ctx, resume)
    )

    expect(server.state.requests.slice(0, 3).map((request) => request.method)).toStrictEqual([
      "thread/resume",
      "thread/start",
      "turn/start"
    ])
    expect(resume.get("s1")).toBe("replacement-thread")
    expect(emitted).toContainEqual({
      _tag: "Started",
      sessionId: "replacement-thread"
    })
    expect(
      server.state.diagnostics
        .filter(({ event }) => event.startsWith("run.") && event !== "run.started")
        .map(({ event }) => event)
    ).toStrictEqual(["run.finished"])
    expect(server.state.diagnosticsCloseCount).toBe(1)
  })

  it("does not replace a resumed thread after an unrelated error", async () => {
    server.state.resumeError = new Error("thread/resume failed: permission denied")
    const { ctx } = harness()

    await expect(
      Effect.runPromise(runCodexAppServer("s1", spec({ resumeId: "thread-1" }), ctx, new Map()))
    ).rejects.toThrow("permission denied")

    expect(server.state.requests.map((request) => request.method)).toStrictEqual(["thread/resume"])
  })

  it("uses GPT-5.6's lightest supported effort for reasoning-off", () => {
    expect(mapCodexAppServerReasoning("xhigh", false)).toBe("low")
    expect(mapCodexAppServerReasoning("medium")).toBe("medium")
  })

  it("emits context while the turn is active, before its terminal event", async () => {
    server.state.messages = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: { totalTokens: 200_000 },
            last: { totalTokens: 120_000 },
            modelContextWindow: 258_400
          }
        }
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: "Done." }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, emitted } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(emitted.map((event) => event._tag)).toStrictEqual([
      "Started",
      "Usage",
      "Assistant",
      "Done"
    ])
    expect(emitted[1]).toStrictEqual({
      _tag: "Usage",
      tokens: 120_000,
      window: 258_400
    })
    expect(server.state.closed).toBe(true)
  })

  it("requests native compaction when an active turn reaches the emergency band", async () => {
    server.state.messages = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: { totalTokens: 240_000 },
            last: { totalTokens: 235_000 },
            modelContextWindow: 258_400
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(server.state.requests).toContainEqual({
      method: "thread/compact/start",
      params: { threadId: "thread-1" }
    })
  })

  it("requests emergency compaction only once when several high readings arrive", async () => {
    server.state.messages = [
      ...[235_000, 240_000, 245_000].map((tokens) => ({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: { totalTokens: tokens },
            last: { totalTokens: tokens },
            modelContextWindow: 258_400
          }
        }
      })),
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(
      server.state.requests.filter((request) => request.method === "thread/compact/start")
    ).toHaveLength(1)
  })

  it("uses the runtime window rather than the model fallback for emergency compaction", async () => {
    server.state.messages = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: { totalTokens: 250_000 },
            last: { totalTokens: 250_000 },
            modelContextWindow: 400_000
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, emitted } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(
      server.state.requests.filter((request) => request.method === "thread/compact/start")
    ).toHaveLength(0)
    expect(emitted).toContainEqual({
      _tag: "Usage",
      tokens: 250_000,
      window: 400_000
    })
  })

  it("compacts an overloaded resumed thread before starting its next turn", async () => {
    server.state.replay = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "previous-turn",
          tokenUsage: {
            total: { totalTokens: 900_000 },
            last: { totalTokens: 206_000 },
            modelContextWindow: 258_400
          }
        }
      }
    ]
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, emitted } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec({ resumeId: "thread-1" }), ctx, new Map()))

    expect(server.state.requests.map((request) => request.method).slice(0, 3)).toStrictEqual([
      "thread/resume",
      "thread/compact/start",
      "turn/start"
    ])
    expect(emitted).toContainEqual({
      _tag: "Usage",
      tokens: 206_000,
      window: 258_400
    })
  })

  it("waits for native compaction to finish before replaying the prompt exactly once", async () => {
    server.state.autoCompleteCompaction = false
    server.state.hangMessages = true
    server.state.replay = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "previous-turn",
          tokenUsage: {
            total: { totalTokens: 900_000 },
            last: { totalTokens: 206_000 },
            modelContextWindow: 258_400
          }
        }
      }
    ]
    const { ctx } = harness()
    const running = Effect.runPromise(
      runCodexAppServer("s1", spec({ resumeId: "thread-1" }), ctx, new Map())
    )

    await vi.waitFor(() => {
      expect(server.state.requests.some((request) => request.method === "thread/compact/start")).toBe(
        true
      )
    })
    expect(server.state.requests.some((request) => request.method === "turn/start")).toBe(false)

    server.state.hangMessages = false
    server.state.messages.push({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null }
      }
    })
    server.state.pendingMessageResolver?.({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-delayed", status: "completed", error: null }
      }
    })
    await running

    expect(
      server.state.requests.filter((request) => request.method === "turn/start")
    ).toHaveLength(1)
    expect(
      server.state.requests.find((request) => request.method === "turn/start")?.params
    ).toMatchObject({
      input: [{ type: "text", text: "inspect the repository", text_elements: [] }]
    })
  })

  it("steers a live regular turn through the registered handle", async () => {
    server.state.hangMessages = true
    const { ctx } = harness()
    const running = Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    await vi.waitFor(() => {
      expect(server.state.turnSteer).not.toBeNull()
      expect(server.state.requests.some((request) => request.method === "turn/start")).toBe(true)
    })
    await expect(server.state.turnSteer?.("new operator input", [])).resolves.toBe("accepted")
    expect(server.state.requests).toContainEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "new operator input", text_elements: [] }]
      }
    })

    server.state.pendingMessageResolver?.({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null }
      }
    })
    await running
    expect(server.state.turnSteer).toBeNull()
  })

  it("waits for delayed replay usage before starting a resumed turn", async () => {
    server.state.delayedReplay = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "previous-turn",
          tokenUsage: {
            total: { totalTokens: 900_000 },
            last: { totalTokens: 206_000 },
            modelContextWindow: 258_400
          }
        }
      }
    ]
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec({ resumeId: "thread-1" }), ctx, new Map()))

    expect(server.state.requests.map((request) => request.method).slice(0, 3)).toStrictEqual([
      "thread/resume",
      "thread/compact/start",
      "turn/start"
    ])
  })

  it("ignores completion events from another turn on the active thread", async () => {
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "compaction-turn", status: "completed", error: null }
        }
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "m1",
            text: "Active turn finished."
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, emitted } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(emitted).toContainEqual({
      _tag: "Assistant",
      text: "Active turn finished."
    })
    expect(emitted.filter((event) => event._tag === "Done")).toHaveLength(1)
  })

  it("bounds the interrupt request before closing a wedged server", async () => {
    vi.stubEnv("JINGLER_CODEX_DIAGNOSTICS_DIR", "/tmp")
    server.state.hangMessages = true
    const { ctx } = harness()
    const fiber = Effect.runFork(runCodexAppServer("s1", spec(), ctx, new Map()))
    await vi.waitFor(() => {
      expect(server.state.requests.some((request) => request.method === "turn/start")).toBe(true)
    })

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(server.state.requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
      options: { timeoutMs: 2_000 }
    })
    expect(server.state.closed).toBe(true)
    await vi.waitFor(() => {
      expect(
        server.state.diagnostics.filter(({ event }) => event.startsWith("run."))
      ).toStrictEqual([
        expect.objectContaining({ event: "run.started" }),
        expect.objectContaining({ event: "run.interrupted" })
      ])
    })
    expect(server.state.diagnosticsCloseCount).toBe(1)
  })

  it("fails instead of waiting forever when an active turn stops emitting events", async () => {
    vi.stubEnv("JINGLER_CODEX_DIAGNOSTICS_DIR", "/tmp")
    vi.useFakeTimers()
    try {
      server.state.hangMessages = true
      const { ctx } = harness()
      const run = expect(
        Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))
      ).rejects.toThrow("Codex turn produced no events")

      await vi.waitFor(() => {
        expect(server.state.requests.some((request) => request.method === "turn/start")).toBe(true)
      })
      await vi.runAllTimersAsync()

      await run
      expect(server.state.closed).toBe(true)
      expect(server.state.diagnostics).toContainEqual({
        event: "turn.inactivity_timeout",
        fields: {
          timeoutMs: 600_000,
          messageCount: 0,
          lastMethod: null
        }
      })
      expect(
        server.state.diagnostics
          .filter(({ event }) => event.startsWith("run.") && event !== "run.started")
          .map(({ event }) => event)
      ).toStrictEqual(["run.failed"])
      expect(server.state.diagnosticsCloseCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("starts a resumed thread directly when replay usage is below the safety band", async () => {
    server.state.replay = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "previous-turn",
          tokenUsage: {
            total: { totalTokens: 180_000 },
            last: { totalTokens: 180_000 },
            modelContextWindow: 258_400
          }
        }
      }
    ]
    server.state.messages = [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec({ resumeId: "thread-1" }), ctx, new Map()))

    expect(server.state.requests.map((request) => request.method).slice(0, 2)).toStrictEqual([
      "thread/resume",
      "turn/start"
    ])
  })

  it("answers a native request-user-input request without starting another turn", async () => {
    server.state.messages = [
      {
        id: "question-1",
        method: "item/tool/requestUserInput",
        params: {
          itemId: "item-1",
          questions: [
            {
              id: "database",
              header: "Database",
              question: "Which database?",
              options: [
                { label: "Postgres", description: "Use the service." },
                { label: "SQLite", description: "Use a local file." }
              ]
            }
          ]
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, asked } = harness()

    await Effect.runPromise(runCodexAppServer("s1", spec(), ctx, new Map()))

    expect(asked).toHaveLength(1)
    expect(server.state.responses).toStrictEqual([
      {
        id: "question-1",
        result: { answers: { database: { answers: ["Postgres"] } } }
      }
    ])
    expect(server.state.requests.filter((request) => request.method === "turn/start")).toHaveLength(
      1
    )
  })

  it("reopens an approved plan with write access and continues on the same thread", async () => {
    const plan = [
      "```plan",
      "summary: Add a column",
      "01 Add column",
      "  intent: Store the tier.",
      "  approach: add a migration",
      "  files: A migrations/003.sql +12",
      "```"
    ].join("\n")
    server.state.messages = [
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: plan }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          item: { type: "agentMessage", id: "m2", text: "Implemented." }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-2", status: "completed", error: null }
        }
      }
    ]
    const { ctx, proposed, emitted } = harness(PlanDecision.Approve({ mode: "accept-edits" }))

    await Effect.runPromise(runCodexAppServer("s1", spec({ mode: "plan" }), ctx, new Map()))

    expect(proposed).toHaveLength(1)
    expect(
      server.state.requests.filter((request) => request.method === "thread/resume")
    ).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: "thread-1",
          sandbox: "workspace-write"
        })
      })
    )
    expect(server.state.requests.filter((request) => request.method === "turn/start")).toHaveLength(
      2
    )
    expect(emitted.some((event) => event._tag === "Assistant")).toBe(true)
  })

  it("accepts an orchestrator plan from auto mode without narrowing native tools", async () => {
    const plan = [
      "```plan",
      "summary: Delegate focused work",
      "01 Implement the component",
      "  intent: Isolate the implementation.",
      "  approach: implement and verify",
      "  files: M src/component.ts +12 -2",
      "```"
    ].join("\n")
    server.state.messages = [
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: plan }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null }
        }
      }
    ]
    const { ctx, proposed } = harness(PlanDecision.Delegate())

    await Effect.runPromise(
      runCodexAppServer(
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
    expect(
      server.state.requests.find((request) => request.method === "thread/start")
    ).toMatchObject({
      params: {
        sandbox: "danger-full-access",
        approvalPolicy: "never"
      }
    })
    expect(
      server.state.requests.filter((request) => request.method === "turn/start")
    ).toHaveLength(1)
  })
})
