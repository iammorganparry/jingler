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
  SubagentCapabilityBroker,
  type SubagentParentSpec
} from "./subagent-capability-broker.js"

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

const call = (
  capability: Awaited<ReturnType<SubagentCapabilityBroker["register"]>>,
  input: { readonly token?: string; readonly childAgent?: string; readonly toolId?: string }
): Promise<Response> => fetch(capability.endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    version: 1,
    token: input.token ?? capability.token,
    parentPiSessionId: capability.parentPiSessionId,
    childAgent: input.childAgent ?? "worker",
    callId: "child-call",
    toolId: input.toolId ?? "inspect",
    arguments: { value: "ok" }
  })
})

describe("SubagentCapabilityBroker", () => {
  const brokers: SubagentCapabilityBroker[] = []
  afterEach(async () => {
    await Promise.all(brokers.map((broker) => broker.close()))
  })

  it("exposes the exact active tool catalog and forwards execution", async () => {
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
    const broker = new SubagentCapabilityBroker()
    brokers.push(broker)
    const capability = await broker.register({
      parentPiSessionId: "parent",
      spec,
      registry,
      context: context()
    })

    expect(capability.tools.map(({ id }) => id)).toEqual(["inspect"])
    const response = await call(capability, {})
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "success",
      value: { inspected: "ok" }
    })
  })

  it("routes child mutations through permission checks and receipts", async () => {
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
    const broker = new SubagentCapabilityBroker()
    brokers.push(broker)
    const capability = await broker.register({
      parentPiSessionId: "parent",
      spec,
      registry,
      context: runtimeContext
    })

    const worker = await call(capability, { childAgent: "worker", toolId: "change" })
    expect(worker.status).toBe(200)
    expect(execute).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledOnce()
    expect(runtimeContext.canUseTool).toHaveBeenCalledWith({
      toolId: "change",
      risk: "mutate"
    })

    const reviewer = await call(capability, {
      childAgent: "reviewer",
      toolId: "change"
    })
    await expect(reviewer.json()).resolves.toMatchObject({
      status: "error",
      error: { code: "forbidden" }
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it("rejects forged and expired capabilities", async () => {
    const registry = new ToolRegistry()
    registry.register({
      id: "inspect",
      version: "1",
      description: "Inspect",
      input: Schema.Struct({ value: Schema.String }),
      risk: "read",
      roles: ["conversation"],
      modes: ["auto"],
      timeoutMs: 1_000,
      outputBudget: 1_000,
      cancellable: true,
      idempotency: "safe",
      execute: () => Promise.resolve("ok")
    })
    const broker = new SubagentCapabilityBroker()
    brokers.push(broker)
    const capability = await broker.register({
      parentPiSessionId: "parent",
      spec,
      registry,
      context: context()
    })

    expect((await call(capability, { token: "forged" })).status).toBe(403)
    broker.unregister("parent")
    expect((await call(capability, {})).status).toBe(403)
  })
})
