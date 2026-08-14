import { defaultPlan } from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { inactiveRuntimeActivity, type AgentRuntimeContext } from "./agent-runtime.js"
import { createJinglerControlTools, createJinglerTools } from "./pi-jingler-tools.js"

const runtimeContext = (overrides: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext => ({
  ...inactiveRuntimeActivity,
  canUseTool: () => Effect.succeed("allow"),
  askQuestion: () => Effect.succeed([]),
  saveDraftPlan: () => Effect.void,
  proposePlan: () => Effect.succeed({ _tag: "Reject" }),
  ...overrides
})

describe("Jingler target-owned tools", () => {
  it("registers WebSearch only when the runtime target supplies an executable route", async () => {
    const withoutSearch = await Effect.runPromise(createJinglerTools({
      context: runtimeContext(),
      cwd: "/workspace"
    }))
    expect(withoutSearch.capabilitiesFor("conversation", "ask").map(({ id }) => id))
      .not.toContain("web_search")

    const withSearch = await Effect.runPromise(createJinglerTools({
      context: runtimeContext(),
      cwd: "/workspace",
      webSearch: {
        search: () => Effect.succeed({ route: "native", results: [] })
      }
    }))
    expect(withSearch.capabilitiesFor("conversation", "ask").map(({ id }) => id))
      .toContain("web_search")
  })
})

describe("Jingler pi control tools", () => {
  it("routes structured questions through AgentRuntimeContext", async () => {
    const askQuestion = vi.fn(() => Effect.succeed([{ selected: ["Yes"], other: null }]))
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

  it("allows a conversation to submit a structured plan", async () => {
    const proposePlan = vi.fn(() => Effect.succeed({ _tag: "Reject" } as const))
    const registry = createJinglerControlTools(runtimeContext({ proposePlan }))
    const plan = defaultPlan("Conversation plan")
    const result = await Effect.runPromise(
      registry.execute({
        id: "jingler_submit_plan",
        arguments: { plan },
        role: "conversation",
        mode: "ask"
      })
    )
    expect(result.status).toBe("success")
    expect(proposePlan).toHaveBeenCalledWith(plan)
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
