import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { ToolRegistry, type ToolDefinition } from "./tool-registry.js"

const definition = (overrides: Partial<ToolDefinition<{ readonly path: string }>> = {}): ToolDefinition<{ readonly path: string }> => ({
  id: "workspace_read",
  version: "1",
  description: "Read a workspace file.",
  input: Schema.Struct({ path: Schema.String }),
  risk: "read",
  roles: ["conversation", "plan", "review"],
  modes: ["ask", "read-only"],
  timeoutMs: 1_000,
  outputBudget: 1_000,
  cancellable: true,
  idempotency: "safe",
  execute: async ({ path }) => ({ path }),
  ...overrides
})

describe("ToolRegistry", () => {
  it("rejects tool ids that provider APIs cannot expose", () => {
    const registry = new ToolRegistry()

    expect(() => registry.register(definition({ id: "workspace.edit" }))).toThrow(
      "invalid tool id: workspace.edit"
    )
  })

  it("rejects invalid arguments before execution", async () => {
    const execute = vi.fn(async () => "never")
    const registry = new ToolRegistry()
    registry.register(definition({ execute }))
    const result = await Effect.runPromise(registry.execute({ id: "workspace_read", arguments: {}, role: "conversation", mode: "ask" }))
    expect(result.error?.code).toBe("invalid-input")
    expect(execute).not.toHaveBeenCalled()
  })

  it("omits mutation and execution tools from plan and review roles", () => {
    const registry = new ToolRegistry()
    registry.register(definition({ id: "workspace_edit", risk: "mutate" }))
    expect(registry.capabilitiesFor("plan", "read-only")).toEqual([])
    expect(registry.capabilitiesFor("review", "read-only")).toEqual([])
  })

  it("caps large output and returns an artifact reference", async () => {
    const registry = new ToolRegistry({
      writeArtifact: async (_tool, content) => ({ id: "artifact-1", byteLength: content.length })
    })
    registry.register(definition({ outputBudget: 8, execute: async () => ({ content: "large output" }) }))
    const result = await Effect.runPromise(registry.execute({
      id: "workspace_read",
      arguments: { path: "README.md" },
      role: "conversation",
      mode: "ask"
    }))
    expect(result.artifact).toMatchObject({ id: "artifact-1" })
    expect(result.preview?.length).toBeLessThanOrEqual(8)
  })

  it("publishes only settled successful values that fit the output budget", async () => {
    const onSuccessfulResult = vi.fn()
    const registry = new ToolRegistry({
      writeArtifact: async (_tool, content) => ({ id: "artifact-1", byteLength: content.length }),
      onSuccessfulResult
    })
    registry.register(definition({
      origin: { kind: "plugin", pluginId: "linear", toolsetId: "linear.issues" }
    }))
    registry.register(definition({
      id: "large_plugin_result",
      outputBudget: 8,
      origin: { kind: "plugin", pluginId: "linear", toolsetId: "linear.issues" },
      execute: async () => ({ content: "large output" })
    }))

    await Effect.runPromise(registry.execute({
      id: "workspace_read",
      arguments: { path: "README.md" },
      role: "conversation",
      mode: "ask",
      callId: "call-1"
    }))
    await Effect.runPromise(registry.execute({
      id: "large_plugin_result",
      arguments: { path: "README.md" },
      role: "conversation",
      mode: "ask",
      callId: "call-2"
    }))

    expect(onSuccessfulResult).toHaveBeenCalledTimes(1)
    expect(onSuccessfulResult).toHaveBeenCalledWith({
      toolId: "workspace_read",
      callId: "call-1",
      risk: "read",
      origin: { kind: "plugin", pluginId: "linear", toolsetId: "linear.issues" },
      value: { path: "README.md" }
    })
  })

  it("does not turn a successful tool into a failure when result observation rejects", async () => {
    const registry = new ToolRegistry({
      onSuccessfulResult: async () => { throw new Error("observer unavailable") }
    })
    registry.register(definition())
    const result = await Effect.runPromise(registry.execute({
      id: "workspace_read",
      arguments: { path: "README.md" },
      role: "conversation",
      mode: "ask"
    }))
    expect(result.status).toBe("success")
  })

  it("cancels a cancellable tool with a tagged result", async () => {
    const registry = new ToolRegistry()
    registry.register(definition({ execute: async (_input, context) =>
      new Promise((resolve) => context.signal.addEventListener("abort", () => resolve("stopped"), { once: true }))
    }))
    const abort = new AbortController()
    const result = Effect.runPromise(registry.execute({
      id: "workspace_read",
      arguments: { path: "README.md" },
      role: "conversation",
      mode: "ask",
      signal: abort.signal
    }))
    abort.abort()
    expect((await result).status).toBe("cancelled")
  })

  it("requires idempotency keys for keyed tools", async () => {
    const registry = new ToolRegistry()
    registry.register(definition({ idempotency: "keyed" }))
    const result = await Effect.runPromise(registry.execute({ id: "workspace_read", arguments: { path: "a" }, role: "conversation", mode: "ask" }))
    expect(result.error?.code).toBe("invalid-input")
  })

  it("refuses mutation when authoritative tracking is unavailable", async () => {
    const execute = vi.fn(async () => null)
    const registry = new ToolRegistry()
    registry.register(
      definition({ id: "workspace_edit", risk: "mutate", execute })
    )
    const result = await Effect.runPromise(
      registry.execute({
        id: "workspace_edit",
        arguments: { path: "a" },
        role: "conversation",
        mode: "ask"
      })
    )
    expect(result.error?.code).toBe("forbidden")
    expect(execute).not.toHaveBeenCalled()
  })
})

it("denies shell, delegation and external tools before execution in safe mode", async () => {
  const { setWorkspaceCheckpointMode, resetWorkspaceAdmissions } = await import("../../workspace-admission.js")
  setWorkspaceCheckpointMode("safe", true)
  try {
    for (const id of ["command_execute", "subagent", "mcp_external", "offload"]) {
      const execute = vi.fn(async () => "never")
      const registry = new ToolRegistry({ checkpointSessionId: "safe" })
      registry.register(definition({ id, execute }))
      const result = await Effect.runPromise(registry.execute({ id, arguments: { path: "file" }, role: "conversation", mode: "ask" }))
      expect(result.error?.code).toBe("forbidden"); expect(execute).not.toHaveBeenCalled()
    }
  } finally { resetWorkspaceAdmissions() }
})

it("owner tools share the admitted turn without closing admission or deadlocking", async () => {
  const { setWorkspaceCheckpointMode, closeWorkspaceAdmission, acquireCheckpointTurnOwner, checkpointTurnOwner, workspaceActivityCount, resetWorkspaceAdmissions } = await import("../../workspace-admission.js")
  setWorkspaceCheckpointMode("safe", true)
  const turn = acquireCheckpointTurnOwner("safe", closeWorkspaceAdmission("safe", "capture"))
  try {
    const registry = new ToolRegistry({ checkpointSessionId: "safe", checkpointOwner: checkpointTurnOwner("safe") })
    registry.register(definition({ id: "workspace_read_file", execute: async () => { expect(workspaceActivityCount("safe")).toBe(2); return "read" } }))
    const result = await Effect.runPromise(registry.execute({ id: "workspace_read_file", arguments: { path: "file" }, role: "conversation", mode: "ask" }))
    expect(result.status).toBe("success"); expect(workspaceActivityCount("safe")).toBe(1)
    turn.release()
    const stale = await Effect.runPromise(registry.execute({ id: "workspace_read_file", arguments: { path: "file" }, role: "conversation", mode: "ask" }))
    expect(stale.status).toBe("error")
  } finally { turn.release(); resetWorkspaceAdmissions() }
})
