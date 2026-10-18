import {
  inactiveRuntimeActivity,
  type AgentRuntimeContext,
  type RuntimePermissionDecision
} from "../agent/agent-runtime.js"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "../tools/tool-registry.js"
import { registerWorkspaceInspectionTools, type WorkspaceInspectionPort } from "../tools/workspace-tools.js"
import { registerWorkspaceMutationTools, type WorkspaceMutationPort } from "../tools/workspace-mutation-tools.js"
import { JINGLER_SUBAGENT_NAMES } from "@jingler/core"
import {
  makeSubagentCapabilityBroker,
  resolveChildCwd,
  subagentProfileToolIds,
  SubagentCapabilityBrokerLive,
  SubagentCapabilityBrokerService,
  type SubagentCapabilityBroker,
  type SubagentParentSpec
} from "./subagent-capability-broker.js"
import type { SubagentCapability } from "@jingler/core"
import { executeRegistryTool } from "../agent/registry-tool-bridge.js"
import { registerProgressiveMcpTools, type McpToolClientFactory } from "../tools/mcp-tools.js"

const spec = {
  role: "conversation",
  mode: "auto",
  targetCapabilities: { targetId: "desktop" }
} satisfies SubagentParentSpec

const context = (
  permission: RuntimePermissionDecision = "allow"
): AgentRuntimeContext => ({
  ...inactiveRuntimeActivity,
  canUseTool: vi.fn(() => Effect.succeed(permission)),
  askQuestion: vi.fn(() => Effect.succeed([])),
})

type Capabilities = ReadonlyArray<SubagentCapability>

const capabilityFor = (capabilities: Capabilities, agent: string) => {
  const capability = capabilities.find((candidate) => candidate.agent === agent)
  if (!capability) throw new Error(`Missing ${agent} capability`)
  return capability
}

const call = (
  capabilities: Capabilities,
  input: {
    readonly agent?: string
    readonly token?: string
    readonly toolId?: string
    readonly claimedAgent?: string
  }
): Promise<Response> => {
  const capability = capabilityFor(capabilities, input.agent ?? "worker")
  return fetch(capability.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      token: input.token ?? capability.token,
      parentRuntimeSessionId: capability.parentRuntimeSessionId,
      ...(input.claimedAgent ? { childAgent: input.claimedAgent } : {}),
      callId: "child-call",
      toolId: input.toolId ?? "inspect",
      arguments: { value: "ok" }
    })
  })
}

const register = (
  broker: SubagentCapabilityBroker,
  registry: ToolRegistry,
  runtimeContext = context()
) => Effect.runPromise(broker.register({
  parentRuntimeSessionId: "parent",
  agents: ["worker", "reviewer"],
  spec,
  registry,
  context: runtimeContext,
  supervisorState: () => ({
    version: 2,
    parentRuntimeSessionId: "parent",
    registryRevision: 1,
    status: "running",
    goalRevision: 0,
    phase: null,
    siblings: [],
    generatedAt: 1
  })
}))

describe("subagentProfileToolIds", () => {
  it("lists the write ceiling for workers regardless of the parent and keeps reviewers read-only", () => {
    const registry = new ToolRegistry()
    for (const [id, risk] of [["inspect", "read"], ["command_execute", "execute"], ["workspace_write", "mutate"]] as const) {
      registry.register({
        id,
        version: "1",
        description: id,
        input: Schema.Struct({}),
        risk,
        roles: ["conversation", "review"],
        modes: ["auto", "read-only"],
        timeoutMs: 1_000,
        outputBudget: 1_000,
        cancellable: true,
        idempotency: "safe",
        execute: () => Promise.resolve("ok")
      })
    }

    expect(subagentProfileToolIds(registry, "worker"))
      .toEqual(["inspect", "command_execute", "workspace_write", "supervisor_state"])
    expect(subagentProfileToolIds(registry, "reviewer")).toEqual(["inspect", "supervisor_state"])
  })
})

describe("subagentProfileToolIds for the production workspace tools", () => {
  const registry = new ToolRegistry()
  registerWorkspaceInspectionTools(registry, "/w", {} as WorkspaceInspectionPort)
  registerWorkspaceMutationTools(registry, "/w", {} as WorkspaceMutationPort)
  const writers = ["command_execute", "workspace_write", "workspace_edit", "workspace_delete", "workspace_rename", "workspace_read_file"]

  it.each(JINGLER_SUBAGENT_NAMES.filter((agent) => !["oracle", "reviewer"].includes(agent)))(
    "gives %s every implementation tool",
    (agent) => {
      expect(subagentProfileToolIds(registry, agent)).toEqual(expect.arrayContaining(writers))
    }
  )

  it.each(["oracle", "reviewer"])("keeps %s read-only", (agent) => {
    const ids = subagentProfileToolIds(registry, agent)
    expect(ids).toEqual(expect.arrayContaining(["workspace_read_file", "command_inspect"]))
    expect(ids).not.toEqual(expect.arrayContaining(["workspace_write"]))
    expect(ids).not.toContain("command_execute")
  })
})

describe("SubagentCapabilityBroker", () => {
  const brokers: SubagentCapabilityBroker[] = []
  afterEach(async () => {
    await Promise.all(brokers.map((broker) => Effect.runPromise(broker.close)))
  })

  it("closes the HTTP broker with its Effect layer scope", async () => {
    let endpoint = ""
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const broker = yield* SubagentCapabilityBrokerService
      const capabilities = yield* broker.register({
        parentRuntimeSessionId: "parent",
        agents: ["worker"],
        spec,
        registry: new ToolRegistry(),
        context: context(),
        supervisorState: () => ({
          version: 2,
          parentRuntimeSessionId: "parent",
          registryRevision: 0,
          status: "running",
          goalRevision: 0,
          phase: null,
          siblings: [],
          generatedAt: 0
        })
      })
      endpoint = capabilities[0]!.endpoint
    }).pipe(Effect.provide(SubagentCapabilityBrokerLive))))

    await expect(fetch(endpoint, { method: "POST" })).rejects.toThrow()
  })

  it("exposes the exact profile-specific tool catalog and forwards execution", async () => {
    const registry = new ToolRegistry()
    registry.register({
      id: "inspect",
      version: "1",
      description: "Inspect a value",
      input: Schema.Struct({ value: Schema.String }),
      risk: "read",
      roles: ["conversation", "review"],
      modes: ["auto", "read-only"],
      timeoutMs: 1_000,
      outputBudget: 1_000,
      cancellable: true,
      idempotency: "safe",
      execute: ({ value }) => Promise.resolve({ inspected: value })
    })
    registry.register({
      id: "empty",
      version: "1",
      description: "Use an empty object input",
      input: Schema.Struct({}),
      risk: "read",
      roles: ["conversation", "review"],
      modes: ["auto", "read-only"],
      timeoutMs: 1_000,
      outputBudget: 1_000,
      cancellable: true,
      idempotency: "safe",
      execute: () => Promise.resolve("ok")
    })
    registry.register({
      id: "jingler_publish_explanation",
      version: "1",
      description: "Parent-only control",
      input: Schema.Struct({}),
      risk: "read",
      roles: ["conversation"],
      modes: ["auto"],
      timeoutMs: 1_000,
      outputBudget: 1_000,
      cancellable: true,
      idempotency: "safe",
      execute: () => Promise.resolve("not-for-children")
    })
    const broker = await Effect.runPromise(makeSubagentCapabilityBroker())
    brokers.push(broker)
    const capabilities = await register(broker, registry)

    expect(capabilities).toHaveLength(2)
    expect(new Set(capabilities.map(({ token }) => token)).size).toBe(2)
    expect(capabilityFor(capabilities, "worker").tools.map(({ id }) => id))
      .toEqual(["inspect", "empty", "supervisor_state"])
    const response = await call(capabilities, {})
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "success",
      value: { inspected: "ok" }
    })
    const parentOnly = await call(capabilities, { toolId: "jingler_publish_explanation" })
    expect(parentOnly.status).toBe(403)
    await expect(parentOnly.json()).resolves.toEqual({ error: "forbidden-tool" })
  })

  it("never lets a child call switch_checkout, which would move the parent's active checkout", async () => {
    const registry = new ToolRegistry()
    registry.register({
      id: "switch_checkout",
      version: "1",
      description: "Work in another repository of this session.",
      input: Schema.Struct({ repoPath: Schema.optional(Schema.String) }),
      risk: "read",
      roles: ["conversation", "plan-execution"],
      modes: ["auto"],
      timeoutMs: 1_000,
      outputBudget: 1_000,
      cancellable: true,
      idempotency: "safe",
      execute: () => Promise.resolve({ status: "switched" })
    })
    const broker = await Effect.runPromise(makeSubagentCapabilityBroker())
    brokers.push(broker)
    const capabilities = await register(broker, registry)

    expect(capabilityFor(capabilities, "worker").tools.map(({ id }) => id))
      .not.toContain("switch_checkout")
    const response = await call(capabilities, { toolId: "switch_checkout" })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "forbidden-tool" })
  })

  it("exposes only the scoped supervisor snapshot through the internal tool", async () => {
    const broker = await Effect.runPromise(makeSubagentCapabilityBroker())
    brokers.push(broker)
    const capabilities = await register(broker, new ToolRegistry())

    const response = await call(capabilities, { toolId: "supervisor_state" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "success",
      value: {
        version: 2,
        parentRuntimeSessionId: "parent",
        siblings: []
      }
    })
  })

  it("binds read-only authorization to the token instead of caller fields", async () => {
    const execute = vi.fn(() => Promise.resolve({ changed: true }))
    const settled = vi.fn(() => Effect.succeed({
      id: "set-1",
      callId: "child-call",
      changes: [],
      totals: { added: 0, removed: 0 },
      authoritative: true,
      reconciledAt: "2026-08-10T00:00:00.000Z"
    }))
    const registry = new ToolRegistry({
      observer: {
        started: () => Effect.succeed({ cwd: "/workspace", tree: "before" }),
        settled
      }
    })
    registry.register({
      id: "change",
      version: "1",
      description: "Change a value",
      input: Schema.Struct({ value: Schema.String }),
      risk: "mutate",
      roles: ["conversation", "review"],
      modes: ["auto", "read-only"],
      timeoutMs: 1_000,
      outputBudget: 1_000,
      cancellable: true,
      idempotency: "keyed",
      execute
    })
    const runtimeContext = context()
    const broker = await Effect.runPromise(makeSubagentCapabilityBroker())
    brokers.push(broker)
    const capabilities = await register(broker, registry, runtimeContext)

    const worker = await call(capabilities, { toolId: "change" })
    expect(worker.status).toBe(200)
    expect(execute).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledOnce()
    expect(runtimeContext.canUseTool).toHaveBeenCalledWith({
      toolId: "change",
      risk: "mutate"
    })

    expect(capabilityFor(capabilities, "reviewer").tools.map(({ id }) => id))
      .toEqual(["supervisor_state"])
    const reviewer = await call(capabilities, {
      agent: "reviewer",
      toolId: "change"
    })
    expect(reviewer.status).toBe(403)
    await expect(reviewer.json()).resolves.toEqual({ error: "forbidden-tool" })
    const impersonation = await call(capabilities, {
      agent: "reviewer",
      toolId: "change",
      claimedAgent: "worker"
    })
    expect(impersonation.status).toBe(422)
    expect(execute).toHaveBeenCalledOnce()
  })

  it("rejects forged, cross-parent, and expired capabilities", async () => {
    const registry = new ToolRegistry()
    registry.register({
      id: "inspect",
      version: "1",
      description: "Inspect",
      input: Schema.Struct({ value: Schema.String }),
      risk: "read",
      roles: ["conversation", "review"],
      modes: ["auto", "read-only"],
      timeoutMs: 1_000,
      outputBudget: 1_000,
      cancellable: true,
      idempotency: "safe",
      execute: () => Promise.resolve("ok")
    })
    const broker = await Effect.runPromise(makeSubagentCapabilityBroker())
    brokers.push(broker)
    const capabilities = await register(broker, registry)

    expect((await call(capabilities, { token: "forged" })).status).toBe(403)
    const worker = capabilityFor(capabilities, "worker")
    const crossParent = await fetch(worker.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        token: worker.token,
        parentRuntimeSessionId: "another-parent",
        callId: "child-call",
        toolId: "inspect",
        arguments: { value: "ok" }
      })
    })
    expect(crossParent.status).toBe(403)
    await Effect.runPromise(broker.unregister("parent"))
    expect((await call(capabilities, {})).status).toBe(403)
  })
  it("serializes child mutations with parent marker edits in the same registry", async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const events: string[] = []
    const registry = new ToolRegistry({ observer: {
      started: (request) => Effect.sync(() => { events.push(`start:${request.callId}`); return { cwd: "/workspace", tree: "before" } }),
      settled: (request) => Effect.sync(() => {
        events.push(`end:${request.callId}`)
        return { id: "receipt", callId: request.callId!, changes: [], totals: { added: 0, removed: 0 }, authoritative: true, reconciledAt: new Date().toISOString() }
      })
    } })
    registry.register({ id: "change", version: "1", description: "change", input: Schema.Struct({ value: Schema.String }), risk: "mutate",
      roles: ["conversation"], modes: ["auto"], timeoutMs: 5000, outputBudget: 1000, cancellable: true, idempotency: "safe",
      execute: async ({ value }) => { if (value === "ok") await waiting; return value } })
    const broker = await Effect.runPromise(makeSubagentCapabilityBroker()); brokers.push(broker)
    const runtimeContext = context()
    const capabilities = await register(broker, registry, runtimeContext)
    const child = call(capabilities, { toolId: "change" })
    await vi.waitFor(() => expect(events).toEqual(["start:child-call"]))
    const parent = executeRegistryTool({ registry, spec, context: runtimeContext, id: "change", toolCallId: "marker", parameters: { value: "marker" }, signal: undefined, allowed: true, onUpdate: undefined })
    await Promise.resolve()
    expect(events).toEqual(["start:child-call"])
    release()
    expect((await child).status).toBe(200)
    expect((await parent).details.status).toBe("success")
    expect(events).toEqual(["start:child-call", "end:child-call", "start:marker", "end:marker"])
  })

  it("gives Claude and Pi subagents the imported claude.ai connector through mcp_search and mcp_call", async () => {
    const connector = { name: "claude-ai-linear", url: "https://mcp.linear.app/mcp", headers: {} }
    const calls: string[] = []
    const factory: McpToolClientFactory = (requested) => requested === connector
      ? Effect.succeed({
          listTools: () => Effect.succeed({ tools: [{ name: "lookup", description: "Look something up", inputSchema: { type: "object", properties: {} } }] }),
          callTool: (name) => Effect.sync(() => { calls.push(name); return { content: [{ type: "text", text: "found" }] } }),
          close: Effect.void
        })
      : Effect.die("unexpected server")
    const registry = new ToolRegistry()
    registerProgressiveMcpTools(registry, [{ server: connector, risk: "network" }], factory)
    const broker = await Effect.runPromise(makeSubagentCapabilityBroker())
    brokers.push(broker)
    const capabilities = await register(broker, registry)

    // Both the worker (Claude/Pi child) and the read-only reviewer see the connector's relay tools.
    for (const agent of ["worker", "reviewer"]) {
      expect(capabilityFor(capabilities, agent).tools.map(({ id }) => id)).toEqual(["mcp_search", "mcp_call", "supervisor_state"])
    }
    const listed = await fetch(capabilityFor(capabilities, "worker").endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, token: capabilityFor(capabilities, "worker").token, parentRuntimeSessionId: "parent", callId: "search", toolId: "mcp_search", arguments: { query: "", server: "claude-ai-linear" } })
    })
    await expect(listed.json()).resolves.toMatchObject({ status: "success", value: { matches: [{ server: "claude-ai-linear", tool: "lookup" }] } })
    const invoked = await fetch(capabilityFor(capabilities, "worker").endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, token: capabilityFor(capabilities, "worker").token, parentRuntimeSessionId: "parent", callId: "call", toolId: "mcp_call", arguments: { server: "claude-ai-linear", tool: "lookup", arguments: {} } })
    })
    expect((await invoked.json() as { status: string }).status).toBe("success")
    expect(calls).toEqual(["lookup"])
  })
})

describe("resolveChildCwd", () => {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
  const { mkdtempSync, realpathSync } = require("node:fs") as typeof import("node:fs")
  const { tmpdir } = require("node:os") as typeof import("node:os")
  const { join } = require("node:path") as typeof import("node:path")
  const repo = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "child-cwd-")))
    execFileSync("git", ["init", "-q"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir })
    return dir
  }

  it("routes a worktree of the parent's repo to the child's own cwd", async () => {
    const parent = repo()
    const lane = join(realpathSync(mkdtempSync(join(tmpdir(), "lane-"))), "lane")
    execFileSync("git", ["worktree", "add", "-q", "-b", "lane", lane], { cwd: parent })
    expect(await resolveChildCwd(parent, lane)).toBe(lane)
  })

  it("forbids a path outside the parent's repo", async () => {
    expect(await resolveChildCwd(repo(), repo())).toBeNull()
  })

  it("falls back to the parent checkout when the child sends no cwd", async () => {
    expect(await resolveChildCwd(repo(), undefined)).toBeUndefined()
  })
})
