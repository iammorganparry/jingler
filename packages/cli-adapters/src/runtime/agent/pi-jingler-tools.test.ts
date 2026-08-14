import { defaultPlan, WebSearchError } from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { inactiveRuntimeActivity, type AgentRuntimeContext } from "./agent-runtime.js"
import {
  createJinglerControlTools,
  createJinglerTools,
  registerWebSearchTool
} from "./pi-jingler-tools.js"
import { ToolRegistry } from "../tools/tool-registry.js"

const runtimeContext = (overrides: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext => ({
  ...inactiveRuntimeActivity,
  canUseTool: () => Effect.succeed("allow"),
  askQuestion: () => Effect.succeed([]),
  saveDraftPlan: () => Effect.void,
  proposePlan: () => Effect.succeed({ _tag: "Reject" }),
  ...overrides
})

describe("Jingler target-owned tools", () => {
  it("offers setup only to an interactive run and persists Skip before retry", async () => {
    const askQuestion = vi.fn(() =>
      Effect.succeed([{ selected: ["Skip"], other: null }])
    )
    const chooseSetup = vi.fn(() => Effect.void)
    let attempts = 0
    const registry = new ToolRegistry()
    registerWebSearchTool(registry, {
      chooseSetup,
      search: () => {
        attempts += 1
        return attempts === 1
          ? Effect.fail(new WebSearchError({
              reason: "setup-required",
              message: "setup",
              retryable: false
            }))
          : Effect.succeed({ route: "browser", results: [] })
      }
    }, runtimeContext({ askQuestion }), true)

    const result = await Effect.runPromise(registry.execute({
      id: "web_search",
      arguments: { query: "research", maxResults: 5 },
      role: "conversation",
      mode: "ask"
    }))
    expect(result.status).toBe("success")
    expect(askQuestion).toHaveBeenCalledOnce()
    expect(chooseSetup).toHaveBeenCalledWith(null)
  })

  it("never waits for setup when no interactive host is attached", async () => {
    const askQuestion = vi.fn(() => Effect.succeed([]))
    const registry = new ToolRegistry()
    registerWebSearchTool(registry, {
      chooseSetup: () => Effect.void,
      search: () => Effect.fail(new WebSearchError({
        reason: "setup-required",
        message: "setup",
        retryable: false
      }))
    }, runtimeContext({ askQuestion }), false)
    const result = await Effect.runPromise(registry.execute({
      id: "web_search",
      arguments: { query: "research", maxResults: 5 },
      role: "conversation",
      mode: "ask"
    }))
    expect(result.status).toBe("error")
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it("treats a null browser lease as detached", async () => {
    const askQuestion = vi.fn(() => Effect.succeed([]))
    const registry = await Effect.runPromise(createJinglerTools({
      context: runtimeContext({ askQuestion }),
      cwd: "/workspace",
      webSearch: {
        chooseSetup: () => Effect.void,
        search: () => Effect.fail(new WebSearchError({
          reason: "setup-required",
          message: "setup",
          retryable: false
        }))
      },
      mcp: { browser: null }
    }))
    const result = await Effect.runPromise(registry.execute({
      id: "web_search",
      arguments: { query: "research", maxResults: 5 },
      role: "conversation",
      mode: "ask"
    }))
    expect(result.status).toBe("error")
    expect(askQuestion).not.toHaveBeenCalled()
  })

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
