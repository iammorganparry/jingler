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

  it("decodes only typed mutation envelopes", () => {
    const issue = {
      providerId: "linear", id: "issue-1", identifier: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1", title: "Fix it", labels: []
    }
    expect(issueReferencesFromPluginResult(origin, {
      kind: "linear.issue-result", linkIntent: "mutation", issues: [issue], result: { title: "Fix it" }
    }, "unrelated request")).toEqual([issue])
    expect(issueReferencesFromPluginResult(origin, {
      kind: "linear.issue-result", issues: [issue]
    }, "ENG-1")).toEqual([])
    expect(issueReferencesFromPluginResult(origin, {
      kind: "linear.issue-result", linkIntent: "mutation", issues: [{ id: "bad" }]
    }, "ENG-1")).toEqual([])
    expect(issueReferencesFromPluginResult(
      { ...origin, pluginId: "other" },
      { kind: "linear.issue-result", linkIntent: "mutation", issues: [issue] },
      "ENG-1"
    )).toEqual([])
    expect(issueReferencesFromPluginResult(origin, {
      kind: "linear.issue-result", linkIntent: "mutation",
      issues: [{ ...issue, providerId: "github" }]
    }, "ENG-1")).toEqual([])
  })

  it("links reference-only results only for an exact user identifier, UUID, or URL", () => {
    const issue = {
      providerId: "linear", id: "6f26f725-f0ac-4d1e-a132-b87a02b1de89", identifier: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1/fix-it", title: "Fix it", labels: []
    }
    const result = {
      kind: "linear.issue-result", linkIntent: "user-reference", issues: [issue]
    }
    expect(issueReferencesFromPluginResult(origin, result, "Please inspect eng-1.")).toEqual([issue])
    expect(issueReferencesFromPluginResult(origin, result, `Inspect ${issue.id}`)).toEqual([issue])
    expect(issueReferencesFromPluginResult(origin, result, `Inspect ${issue.url}`)).toEqual([issue])
    expect(issueReferencesFromPluginResult(origin, result, "Search ENG-12 instead")).toEqual([])
    expect(issueReferencesFromPluginResult(origin, result, "Search FOO-ENG-1 instead")).toEqual([])
    expect(issueReferencesFromPluginResult(origin, result, "Fix it")).toEqual([])
    expect(issueReferencesFromPluginResult(origin, {
      ...result,
      issues: [{ ...issue, id: "", identifier: "", url: "" }]
    }, "unrelated request")).toEqual([])
  })

  it("persists mutations but ignores discovery and unreferenced reads", async () => {
    const issue = {
      providerId: "linear", id: "issue-1", identifier: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1", title: "Fix it", labels: []
    }
    const persist = vi.fn(async () => undefined)
    await expect(persistPluginIssueReferences(
      origin,
      { kind: "linear.issue-result", linkIntent: "mutation", issues: [issue] },
      "unrelated request",
      persist
    )).resolves.toBe(true)
    await expect(persistPluginIssueReferences(
      origin,
      { kind: "linear.issue-result", linkIntent: "none", issues: [issue] },
      "ENG-1",
      persist
    )).resolves.toBe(false)
    await expect(persistPluginIssueReferences(
      origin,
      { kind: "linear.issue-result", linkIntent: "user-reference", issues: [issue] },
      "unrelated request",
      persist
    )).resolves.toBe(false)
    expect(persist).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledWith([issue])
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
