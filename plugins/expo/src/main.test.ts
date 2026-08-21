import type {
  AgentToolExecutionContext,
  AgentToolset,
  HostContext
} from "@jingler/plugin-sdk/host"
import { describe, expect, it, vi } from "vitest"
import { expoAgentTools, expoAutomationTools, registerExpo } from "./main.js"

type CommandHandler = Parameters<HostContext["commands"]["register"]>[1]

const controller = () => ({
  inspect: vi.fn(async () => ({ ready: true })),
  start: vi.fn(async (input) => ({
    ready: true,
    phase: "starting" as const,
    logs: [],
    sessionId: input.sessionId
  })),
  status: vi.fn(async (input) => ({
    ready: true,
    phase: "running" as const,
    logs: [],
    sessionId: input.sessionId,
    simulator: { udid: "sim-1", name: "iPhone 16", state: "Booted" }
  })),
  frame: vi.fn(),
  reload: vi.fn(async () => ({ ready: true, phase: "running" as const, logs: [] })),
  stop: vi.fn(async () => ({ ready: true, phase: "stopped" as const, logs: [] })),
  openSimulator: vi.fn(async () => undefined),
  dispose: vi.fn(async () => undefined)
} satisfies Parameters<typeof expoAgentTools>[0])

const executionContext = (signal = new AbortController().signal): AgentToolExecutionContext => ({
  signal,
  session: {
    id: "session-1",
    repository: { name: "acme/mobile", path: "/trusted/mobile" }
  }
})

const tool = (tools: AgentToolset["tools"], id: string) => {
  const found = tools.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing tool ${id}`)
  return found
}

describe("Expo tool registration", () => {
  it("registers one manifest-backed native toolset", async () => {
    const registered: AgentToolset[] = []
    const handlers = new Map<string, CommandHandler>()
    const subscriptions: Array<{ dispose(): void }> = []
    const context = {
      agentTools: {
        registerToolset: (toolset: AgentToolset) => {
          registered.push(toolset)
          return { dispose: () => undefined }
        }
      },
      commands: {
        register: (id: string, handler: CommandHandler) => {
          handlers.set(id, handler)
          return { dispose: () => undefined }
        }
      },
      sessions: {
        get: vi.fn(async () => ({
          id: "session-1",
          repo: "acme/mobile",
          branch: "feat/mobile",
          title: "Mobile",
          prNumber: null,
          worktreePath: "/trusted/mobile"
        }))
      },
      subscriptions,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    } satisfies Parameters<typeof registerExpo>[0]

    const preview = controller()
    registerExpo(context, preview)

    expect(registered).toHaveLength(1)
    expect(registered[0]?.id).toBe("expo.ios-preview")
    expect(registered[0]?.tools.map(({ id }) => id)).toEqual([
      "expo_preview_status",
      "expo_preview_open",
      "expo_preview_reload",
      "expo_preview_stop",
      "expo_preview_open_simulator"
    ])
    expect(subscriptions).toHaveLength(9)

    await handlers.get("expo.start")?.({
      sessionId: "session-1",
      worktreePath: "/forged/mobile"
    })
    expect(context.sessions.get).toHaveBeenCalledWith("session-1")
    expect(preview.start).toHaveBeenCalledWith({
      sessionId: "session-1",
      worktreePath: "/trusted/mobile"
    })
  })
})

describe("Expo native agent tools", () => {
  it("routes lifecycle calls with trusted session context, not model input", async () => {
    const preview = controller()
    const tools = expoAgentTools(preview)

    await tool(tools, "expo_preview_open").execute(
      { sessionId: "forged", worktreePath: "/tmp/forged" },
      executionContext()
    )

    expect(preview.start).toHaveBeenCalledWith({
      sessionId: "session-1",
      worktreePath: "/trusted/mobile"
    })
  })

  it("routes semantic automation to the owned booted simulator", async () => {
    const preview = controller()
    const automation = {
      run: vi.fn(async () => ({ ok: true as const, kind: "tap", value: "tapped" }))
    } satisfies Parameters<typeof expoAutomationTools>[1]
    const tools = expoAutomationTools(preview, automation)

    await tool(tools, "expo_preview_tap").execute(
      { selector: { identifier: "save" } },
      executionContext()
    )

    expect(automation.run).toHaveBeenCalledWith(
      { kind: "tap", selector: { identifier: "save" } },
      "/trusted/mobile",
      "sim-1",
      expect.any(AbortSignal)
    )
  })

  it("exposes bounded metadata and refuses an already cancelled call", () => {
    const preview = controller()
    const tools = expoAgentTools(preview)
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "expo_preview_status",
        risk: "read",
        idempotency: "safe",
        outputBudget: 8_000,
        cancellable: true
      }),
      expect.objectContaining({
        id: "expo_preview_open",
        risk: "execute",
        idempotency: "keyed"
      })
    ]))
    const aborted = new AbortController()
    aborted.abort()

    expect(() =>
      tool(tools, "expo_preview_open").execute({}, executionContext(aborted.signal))
    ).toThrow("cancelled")
    expect(preview.start).not.toHaveBeenCalled()
  })
})
