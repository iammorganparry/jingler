import { Schema } from "effect"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  ToolRegistry,
  type ToolMemoryHooks,
  type ToolResultEnvelope
} from "../tools/tool-registry.js"
import { registerWorkspaceInspectionTools } from "../tools/workspace-tools.js"
import { inactiveRuntimeActivity, type AgentRuntimeContext } from "./agent-runtime.js"
import { createPiTools } from "./pi-tool-bridge.js"

const spec = {
  role: "conversation",
  mode: "ask"
} as const

const mutationRegistry = (
  execute: () => Promise<unknown>,
  denied: () => Effect.Effect<void> = () => Effect.void,
  memory?: ToolMemoryHooks
): ToolRegistry => {
  const registry = new ToolRegistry({
    ...(memory === undefined ? {} : { memory }),
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
        }),
      denied
    }
  })
  registry.register({
    id: "workspace_edit",
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
      ...inactiveRuntimeActivity,
      canUseTool,
      askQuestion: () => Effect.succeed([]),
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
    expect(canUseTool).toHaveBeenCalledWith({ toolId: "workspace_edit", risk: "mutate" })
    expect(execute).toHaveBeenCalledOnce()
    expect(result?.details).toMatchObject({ status: "success" })
  })

  it("structurally blocks non-memory tools during hidden reflection", async () => {
    const execute = vi.fn(async () => ({ changed: true }))
    const canUseTool = vi.fn(() => Effect.succeed("allow" as const))
    const registry = mutationRegistry(execute)
    const [tool] = createPiTools(registry, spec, {
      ...inactiveRuntimeActivity,
      canUseTool,
      askQuestion: () => Effect.succeed([]),
    }, { allowTool: () => false })

    const result = await tool?.execute(
      "hidden-workspace-edit",
      { path: "src/hidden.ts" },
      undefined,
      undefined,
      {} as never
    )

    expect((result!.details as ToolResultEnvelope)).toMatchObject({
      status: "error",
      error: { code: "forbidden" }
    })
    expect(canUseTool).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it("returns cited tool memory before allowing risky execution", async () => {
    const memory: ToolMemoryHooks = {
      recall: async () => "<tool-memory>revision:accepted-1</tool-memory>",
      recordFailure: async () => undefined,
      failures: () => []
    }
    const execute = vi.fn(async () => ({ changed: true }))
    const registry = mutationRegistry(execute, () => Effect.void, memory)
    const [tool] = createPiTools(registry, spec, {
      ...inactiveRuntimeActivity,
      canUseTool: () => Effect.succeed("allow"),
      askQuestion: () => Effect.succeed([]),
    })

    const result = await tool?.execute(
      "call-memory",
      { path: "src/a.ts" },
      undefined,
      undefined,
      {} as never
    )

    expect(result?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^<tool-memory>[\s\S]*Review the cited tool memory/u)
    })
    expect((result!.details as ToolResultEnvelope)).toMatchObject({
      status: "error",
      value: null,
      error: { retryable: true }
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it("advertises no-argument tools as strict object schemas", () => {
    const registry = new ToolRegistry()
    registerWorkspaceInspectionTools(registry, "/workspace", {
      listFiles: () => Effect.succeed([]),
      executeReadOnly: (_cwd, program, args) => Effect.succeed({
        command: [program, ...args].join(" "), exitCode: 0, stdout: "", stderr: ""
      }),
      readTextFile: (_cwd, path) =>
        Effect.succeed({ path, text: "", language: null, revision: "rev-1" })
    })

    const tool = createPiTools(registry, spec, {
      ...inactiveRuntimeActivity,
      canUseTool: () => Effect.succeed("allow"),
      askQuestion: () => Effect.succeed([]),
    }).find(({ name }) => name === "workspace_list_files")

    expect(tool?.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    })
  })
})

describe("pi tool permission denial", () => {
  it("does not execute a denied mutation", async () => {
    const execute = vi.fn(async () => null)
    const denied = vi.fn(() => Effect.void)
    const registry = mutationRegistry(execute, denied)
    const context: AgentRuntimeContext = {
      ...inactiveRuntimeActivity,
      canUseTool: () => Effect.succeed("deny"),
      askQuestion: () => Effect.succeed([]),
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
    expect(denied).toHaveBeenCalledOnce()
    expect(result?.details).toMatchObject({
      status: "error",
      error: { code: "forbidden" }
    })
  })
})
