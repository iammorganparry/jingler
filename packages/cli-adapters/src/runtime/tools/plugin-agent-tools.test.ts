import type { LoadedPlugin } from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { PluginHostRuntime } from "../../plugin-host.js"
import { ToolRegistry } from "./tool-registry.js"
import {
  enabledPluginAgentToolsets,
  issueReferencesFromPluginResult,
  persistPluginIssueReferences,
  registerPluginAgentTools
} from "./plugin-agent-tools.js"

const plugin = (enabled = true): LoadedPlugin => ({
  manifest: {
    id: "linear",
    name: "Linear",
    version: "1.0.0",
    main: "dist/main.js",
    contributes: {
      agentToolsets: [{
        id: "linear.issues",
        label: "Linear issues",
        description: "Work with Linear issues."
      }]
    }
  },
  dir: "/plugins/linear",
  enabled,
  activated: false,
  builtin: true
})

const origin = { kind: "plugin", pluginId: "linear", toolsetId: "linear.issues" } as const

const context = {
  id: "session-1",
  repository: { name: "acme/widgets", path: "/repos/widgets" }
}

const descriptor = {
  id: "linear_get_issue",
  description: "Get a Linear issue.",
  inputSchema: {
    type: "object" as const,
    properties: { id: { type: "string" } },
    required: ["id"]
  },
  risk: "network" as const,
  timeoutMs: 30_000,
  outputBudget: 8_000,
  cancellable: true,
  idempotency: "safe" as const
}

describe("plugin agent tools", () => {
  it("selects only enabled host-backed toolsets", () => {
    expect(enabledPluginAgentToolsets([plugin(), plugin(false)])).toEqual([{
      plugin: plugin(),
      toolsetId: "linear.issues"
    }])
  })

  it("registers provider schemas and passes trusted context outside model input", async () => {
    const loadAgentToolset = vi.fn(async () => [descriptor])
    const invokeAgentTool = vi.fn(async () => ({ id: "issue-1" }))
    const host = { loadAgentToolset, invokeAgentTool } as unknown as PluginHostRuntime
    const registry = new ToolRegistry()
    const sources = enabledPluginAgentToolsets([plugin()])

    expect(await registerPluginAgentTools(registry, host, sources, context)).toEqual([])
    expect(registry.providerInputSchemaFor(descriptor.id)).toEqual(descriptor.inputSchema)
    const result = await Effect.runPromise(registry.execute({
      id: descriptor.id,
      arguments: { id: "ENG-1" },
      role: "conversation",
      mode: "ask"
    }))

    expect(result.value).toEqual({ id: "issue-1" })
    expect(invokeAgentTool).toHaveBeenCalledWith(
      plugin(),
      "linear.issues",
      descriptor.id,
      { id: "ENG-1" },
      context,
      expect.any(AbortSignal)
    )
  })

  it("decodes only typed issue-link envelopes", () => {
    const issue = {
      providerId: "linear", id: "issue-1", identifier: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1", title: "Fix it", labels: []
    }
    expect(issueReferencesFromPluginResult(origin, {
      kind: "linear.issue-result", issues: [issue], result: { title: "Fix it" }
    })).toEqual([issue])
    expect(issueReferencesFromPluginResult(origin, { issues: [issue] })).toEqual([])
    expect(issueReferencesFromPluginResult(origin, { kind: "linear.issue-result", issues: [{ id: "bad" }] })).toEqual([])
    expect(issueReferencesFromPluginResult(
      { ...origin, pluginId: "other" },
      { kind: "linear.issue-result", issues: [issue] }
    )).toEqual([])
    expect(issueReferencesFromPluginResult(origin, {
      kind: "linear.issue-result", issues: [{ ...issue, providerId: "github" }]
    })).toEqual([])
  })

  it("persists every typed issue atomically and ignores untyped results", async () => {
    const issue = {
      providerId: "linear", id: "issue-1", identifier: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1", title: "Fix it", labels: []
    }
    const persist = vi.fn(async () => undefined)
    await expect(persistPluginIssueReferences(
      origin,
      { kind: "linear.issue-result", issues: [issue, { ...issue, id: "issue-2", identifier: "ENG-2" }] },
      persist
    )).resolves.toBe(true)
    await expect(persistPluginIssueReferences(origin, { kind: "other", issues: [issue] }, persist)).resolves.toBe(false)
    expect(persist).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledWith([issue, { ...issue, id: "issue-2", identifier: "ENG-2" }])
  })

  it("isolates a broken or colliding toolset", async () => {
    const registry = new ToolRegistry()
    registry.register({
      id: descriptor.id,
      version: "1",
      description: "Built in wins.",
      input: Schema.Struct({ id: Schema.String }),
      risk: "read",
      roles: ["conversation"],
      modes: ["ask"],
      timeoutMs: 1_000,
      outputBudget: 1_000,
      cancellable: true,
      idempotency: "safe",
      execute: async () => null
    })
    const host = {
      loadAgentToolset: vi.fn(async () => [descriptor]),
      invokeAgentTool: vi.fn()
    } as unknown as PluginHostRuntime

    const failures = await registerPluginAgentTools(
      registry,
      host,
      enabledPluginAgentToolsets([plugin()]),
      context
    )
    expect(failures).toEqual([expect.objectContaining({
      pluginId: "linear",
      toolsetId: "linear.issues",
      message: expect.stringContaining("already registered")
    })])
    expect(registry.capabilitiesFor("conversation", "ask")).toEqual([
      expect.objectContaining({ description: "Built in wins." })
    ])
  })
})
