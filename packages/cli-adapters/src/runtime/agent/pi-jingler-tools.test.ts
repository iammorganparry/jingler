import { defaultPlan } from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { AgentRuntimeContext } from "./agent-runtime.js"
import { createJinglerControlTools } from "./pi-jingler-tools.js"

const runtimeContext = (
  overrides: Partial<AgentRuntimeContext> = {}
): AgentRuntimeContext => ({
  canUseTool: () => Effect.succeed("allow"),
  askQuestion: () => Effect.succeed([]),
  saveDraftPlan: () => Effect.void,
  proposePlan: () => Effect.succeed({ _tag: "Reject" }),
  ...overrides
})

describe("Jingler pi control tools", () => {
  it("routes structured questions through AgentRuntimeContext", async () => {
    const askQuestion = vi.fn(() =>
      Effect.succeed([{ selected: ["Yes"], other: null }])
    )
    const registry = createJinglerControlTools(runtimeContext({ askQuestion }))
    const request = {
      id: "question-1",
      questions: [
        {
          question: "Continue?",
          header: "Continue",
          options: [
            { label: "Yes", description: "Continue the work." },
            { label: "No", description: "Stop the work." }
          ],
          multiSelect: false
        }
      ]
    }
    const result = await Effect.runPromise(
      registry.execute({
        id: "jingler_ask_question",
        arguments: request,
        role: "conversation",
        mode: "ask"
      })
    )
    expect(askQuestion).toHaveBeenCalledWith(request)
    expect(result).toMatchObject({ status: "success" })
  })
})

describe("Jingler plan tool containment", () => {
  it("submits the canonical PlanPrd contract in plan mode", async () => {
    const proposePlan = vi.fn(() => Effect.succeed({ _tag: "Reject" } as const))
    const registry = createJinglerControlTools(runtimeContext({ proposePlan }))
    const plan = defaultPlan("Runtime cutover")
    const result = await Effect.runPromise(
      registry.execute({
        id: "jingler_submit_plan",
        arguments: { plan },
        role: "plan",
        mode: "plan"
      })
    )
    expect(result.status).toBe("success")
    expect(proposePlan).toHaveBeenCalledWith(plan)
  })

  it("keeps plan submission unavailable outside the plan role", async () => {
    const proposePlan = vi.fn(() => Effect.succeed({ _tag: "Reject" } as const))
    const registry = createJinglerControlTools(runtimeContext({ proposePlan }))
    const result = await Effect.runPromise(
      registry.execute({
        id: "jingler_submit_plan",
        arguments: { plan: {} },
        role: "conversation",
        mode: "ask"
      })
    )
    expect(result.error?.code).toBe("forbidden")
    expect(proposePlan).not.toHaveBeenCalled()
  })

  it("keeps plan submission available to the producing agent during execution", async () => {
    const proposePlan = vi.fn(() =>
      Effect.succeed({ _tag: "Approve" as const, mode: "auto" as const })
    )
    const registry = createJinglerControlTools(runtimeContext({ proposePlan }))
    const plan = defaultPlan("Amended runtime cutover")

    const result = await Effect.runPromise(
      registry.execute({
        id: "jingler_submit_plan",
        arguments: { plan },
        role: "plan-execution",
        mode: "auto"
      })
    )
    expect(result.status).toBe("success")
    expect(proposePlan).toHaveBeenCalledWith(plan)
  })
})
