import { Schema } from "effect"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "../tools/tool-registry.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"
import { createPiTools } from "./pi-tool-bridge.js"

const spec = {
  role: "conversation",
  mode: "ask"
} as const

const mutationRegistry = (execute: () => Promise<unknown>): ToolRegistry => {
  const registry = new ToolRegistry({
    observer: {
      started: () => Effect.succeed({ cwd: "/workspace", tree: "tree-before" }),
      settled: (_request, _risk, _state, _result) =>
        Effect.succeed({
          id: "set-1",
          callId: "call-1",
          changes: [],
          totals: { added: 0, removed: 0 },
          authoritative: true,
          reconciledAt: "2026-08-10T00:00:00.000Z"
        })
    }
  })
  registry.register({
    id: "workspace.edit",
    version: "1",
    description: "Edit a file.",
    input: Schema.Struct({ path: Schema.String }),
    risk: "mutate",
    roles: ["conversation"],
    modes: ["ask"],
    timeoutMs: 1_000,
    outputBudget: 1_000,
    cancellable: true,
    idempotency: "keyed",
    execute
  })
  return registry
}

describe("pi tool bridge", () => {
  it("gates mutation tools and executes through the Effect registry", async () => {
    const execute = vi.fn(async () => ({ changed: true }))
    const canUseTool = vi.fn(() => Effect.succeed("allow" as const))
    const registry = mutationRegistry(execute)
    const context: AgentRuntimeContext = {
      canUseTool,
      askQuestion: () => Effect.succeed([]),
      saveDraftPlan: () => Effect.void,
      proposePlan: () => Effect.succeed({ _tag: "Reject" })
    }
    const [tool] = createPiTools(registry, spec, context)

    expect(tool?.parameters).toMatchObject({
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } }
    })

    const result = await tool?.execute(
      "call-1",
      { path: "src/a.ts" },
      undefined,
      undefined,
      {} as never
    )
    expect(canUseTool).toHaveBeenCalledWith(
      { toolId: "workspace.edit", risk: "mutate" }
    )
    expect(execute).toHaveBeenCalledOnce()
    expect(result?.details).toMatchObject({ status: "success" })
  })

})

describe("pi tool permission denial", () => {
  it("does not execute a denied mutation", async () => {
    const execute = vi.fn(async () => null)
    const registry = mutationRegistry(execute)
    const context: AgentRuntimeContext = {
      canUseTool: () => Effect.succeed("deny"),
      askQuestion: () => Effect.succeed([]),
      saveDraftPlan: () => Effect.void,
      proposePlan: () => Effect.succeed({ _tag: "Reject" })
    }
    const [tool] = createPiTools(registry, spec, context)

    const result = await tool?.execute(
      "call-1",
      { path: "src/a.ts" },
      undefined,
      undefined,
      {} as never
    )
    expect(execute).not.toHaveBeenCalled()
    expect(result?.details).toMatchObject({
      status: "error",
      error: { code: "forbidden" }
    })
  })
})
