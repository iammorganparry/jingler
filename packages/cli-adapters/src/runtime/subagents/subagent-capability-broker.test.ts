import {
  inactiveRuntimeActivity,
  type AgentRuntimeContext,
  type RuntimePermissionDecision,
  type RuntimePlanDecision
} from "../agent/agent-runtime.js"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "../tools/tool-registry.js"
import {
  makeSubagentCapabilityBroker,
  SubagentCapabilityBrokerLive,
  SubagentCapabilityBrokerService,
  type SubagentCapabilityBroker,
  type SubagentParentSpec
} from "./subagent-capability-broker.js"
import type { SubagentCapability } from "@jingler/core"

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
  saveDraftPlan: vi.fn(() => Effect.void),
  proposePlan: vi.fn(() => Effect.succeed({
    _tag: "Approve",
    mode: "auto"
  } satisfies RuntimePlanDecision))
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
      parentPiSessionId: capability.parentPiSessionId,
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
  parentPiSessionId: "parent",
  agents: ["worker", "reviewer"],
  spec,
  registry,
  context: runtimeContext,
  supervisorState: () => ({
    version: 2,
    parentPiSessionId: "parent",
    registryRevision: 1,
    status: "running",
    goalRevision: 0,
    phase: null,
    siblings: [],
    generatedAt: 1
  })
}))

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
        parentPiSessionId: "parent",
        agents: ["worker"],
        spec,
        registry: new ToolRegistry(),
        context: context(),
        supervisorState: () => ({
          version: 2,
          parentPiSessionId: "parent",
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
      id: "jingler_submit_plan",
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
        parentPiSessionId: "parent",
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
    await expect(reviewer.json()).resolves.toMatchObject({
      status: "error",
      error: { code: "forbidden" }
    })
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
        parentPiSessionId: "another-parent",
        callId: "child-call",
        toolId: "inspect",
        arguments: { value: "ok" }
      })
    })
    expect(crossParent.status).toBe(403)
    await Effect.runPromise(broker.unregister("parent"))
    expect((await call(capabilities, {})).status).toBe(403)
  })
})
