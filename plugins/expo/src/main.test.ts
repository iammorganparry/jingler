import type {
  AgentToolExecutionContext,
  AgentToolset,
  HostContext
} from "@jingler/plugin-sdk/host"
import { describe, expect, it, vi } from "vitest"
import { expoAgentTools, registerExpo } from "./main.js"
import type { ExpoPreviewController } from "./runtime.js"

const controller = () => ({
  inspect: vi.fn(async () => ({ ready: true })),
  start: vi.fn(async (input) => ({ ready: true, phase: "starting", logs: [], sessionId: input.sessionId })),
  status: vi.fn(async (input) => ({ ready: true, phase: "running", logs: [], sessionId: input.sessionId })),
  frame: vi.fn(),
  reload: vi.fn(async () => ({ ready: true, phase: "running", logs: [] })),
  stop: vi.fn(async () => ({ ready: true, phase: "stopped", logs: [] })),
  openSimulator: vi.fn(async () => undefined),
  dispose: vi.fn(async () => undefined)
}) as unknown as ExpoPreviewController

const executionContext = (signal = new AbortController().signal): AgentToolExecutionContext => ({
  signal,
  session: {
    id: "session-1",
    repository: { name: "acme/mobile", path: "/trusted/mobile" }
  }
})

const tool = (tools: readonly ReturnType<typeof expoAgentTools>[number][], id: string) => {
  const found = tools.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing tool ${id}`)
  return found
}

describe("Expo native agent tools", () => {
  it("registers one manifest-backed native toolset", () => {
    const registered: AgentToolset[] = []
    const subscriptions: Array<{ dispose(): void }> = []
    const context = {
      agentTools: {
        registerToolset: (toolset: AgentToolset) => {
          registered.push(toolset)
          return { dispose: () => undefined }
        }
      },
      commands: { register: () => ({ dispose: () => undefined }) },
      subscriptions,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    } as unknown as HostContext

    registerExpo(context, controller())

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
  })

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

  it("exposes bounded metadata and refuses an already cancelled call", async () => {
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
