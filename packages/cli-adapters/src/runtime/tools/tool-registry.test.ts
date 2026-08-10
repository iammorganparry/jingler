import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { ToolRegistry, type ToolDefinition } from "./tool-registry.js"

const definition = (overrides: Partial<ToolDefinition<{ readonly path: string }>> = {}): ToolDefinition<{ readonly path: string }> => ({
  id: "workspace.read",
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
  it("rejects invalid arguments before execution", async () => {
    const execute = vi.fn(async () => "never")
    const registry = new ToolRegistry()
    registry.register(definition({ execute }))
    const result = await Effect.runPromise(registry.execute({ id: "workspace.read", arguments: {}, role: "conversation", mode: "ask" }))
    expect(result.error?.code).toBe("invalid-input")
    expect(execute).not.toHaveBeenCalled()
  })

  it("omits mutation and execution tools from plan and review roles", () => {
    const registry = new ToolRegistry()
    registry.register(definition({ id: "workspace.edit", risk: "mutate" }))
    expect(registry.capabilitiesFor("plan", "read-only")).toEqual([])
    expect(registry.capabilitiesFor("review", "read-only")).toEqual([])
  })

  it("caps large output and returns an artifact reference", async () => {
    const registry = new ToolRegistry({
      writeArtifact: async (_tool, content) => ({ id: "artifact-1", byteLength: content.length })
    })
    registry.register(definition({ outputBudget: 8, execute: async () => ({ content: "large output" }) }))
    const result = await Effect.runPromise(registry.execute({
      id: "workspace.read",
      arguments: { path: "README.md" },
      role: "conversation",
      mode: "ask"
    }))
    expect(result.artifact).toMatchObject({ id: "artifact-1" })
    expect(result.preview?.length).toBeLessThanOrEqual(8)
  })

  it("cancels a cancellable tool with a tagged result", async () => {
    const registry = new ToolRegistry()
    registry.register(definition({ execute: async (_input, context) =>
      new Promise((resolve) => context.signal.addEventListener("abort", () => resolve("stopped"), { once: true }))
    }))
    const abort = new AbortController()
    const result = Effect.runPromise(registry.execute({
      id: "workspace.read",
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
    const result = await Effect.runPromise(registry.execute({ id: "workspace.read", arguments: { path: "a" }, role: "conversation", mode: "ask" }))
    expect(result.error?.code).toBe("invalid-input")
  })

  it("refuses mutation when authoritative tracking is unavailable", async () => {
    const execute = vi.fn(async () => null)
    const registry = new ToolRegistry()
    registry.register(
      definition({ id: "workspace.edit", risk: "mutate", execute })
    )
    const result = await Effect.runPromise(
      registry.execute({
        id: "workspace.edit",
        arguments: { path: "a" },
        role: "conversation",
        mode: "ask"
      })
    )
    expect(result.error?.code).toBe("forbidden")
    expect(execute).not.toHaveBeenCalled()
  })
})
