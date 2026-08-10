import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { createJinglerControlTools } from "./pi-jingler-tools.js"

const runtimeContext = (overrides: Record<string, unknown> = {}) => ({
  canUseTool: () => Effect.succeed(true),
  askQuestion: () => Effect.succeed(null),
  saveDraftPlan: () => Effect.void,
  proposePlan: () => Effect.succeed(null),
  ...overrides
})

describe("Jingler pi control tools", () => {
  it("routes structured questions through AgentRuntimeContext", async () => {
    const askQuestion = vi.fn(() =>
      Effect.succeed([{ selected: ["Yes"], other: null }])
    )
    const registry = createJinglerControlTools(
      runtimeContext({ askQuestion }) as never
    )
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
  it("keeps plan submission unavailable outside the plan role", async () => {
    const proposePlan = vi.fn(() => Effect.succeed(null))
    const registry = createJinglerControlTools(
      runtimeContext({ proposePlan }) as never
    )
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
})
