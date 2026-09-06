import { type ExplanationPayload, WebSearchError } from "@jingler/core"
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

  it("interrupts an open setup question when the tool is cancelled", async () => {
    let questionInterrupted = false
    const askQuestion = vi.fn(() => Effect.async<never, never>(() =>
      Effect.sync(() => { questionInterrupted = true })
    ))
    const chooseSetup = vi.fn(() => Effect.void)
    const registry = new ToolRegistry()
    registerWebSearchTool(registry, {
      chooseSetup,
      search: () => Effect.fail(new WebSearchError({
        reason: "setup-required",
        message: "setup",
        retryable: false
      }))
    }, runtimeContext({ askQuestion }), true)
    const controller = new AbortController()
    const pending = Effect.runPromise(registry.execute({
      id: "web_search",
      arguments: { query: "research", maxResults: 5 },
      role: "conversation",
      mode: "ask",
      signal: controller.signal
    }))
    await vi.waitFor(() => expect(askQuestion).toHaveBeenCalledOnce())
    controller.abort()
    const result = await pending
    expect(result.status).toBe("cancelled")
    await vi.waitFor(() => expect(questionInterrupted).toBe(true))
    expect(chooseSetup).not.toHaveBeenCalled()
  })

  it.each([
    ["rate-limited", true, "error", "execution-failed"],
    ["authentication", false, "error", "execution-failed"],
    ["cancelled", true, "cancelled", "cancelled"]
  ] as const)(
    "preserves %s retryability and cancellation at the tool boundary",
    async (reason, retryable, status, code) => {
      const registry = new ToolRegistry()
      registerWebSearchTool(registry, {
        search: () => Effect.fail(new WebSearchError({
          reason,
          message: `search ${reason}`,
          retryable
        }))
      }, runtimeContext(), false)
      const result = await Effect.runPromise(registry.execute({
        id: "web_search",
        arguments: { query: "research", maxResults: 5 },
        role: "conversation",
        mode: "ask"
      }))
      expect(result).toMatchObject({
        status,
        error: { code, message: `search ${reason}`, retryable }
      })
    }
  )

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

describe("Jingler peer-agent tools", () => {
  it("lists peers and delivers an attributed target message through run callbacks", async () => {
    const listPeerAgents = vi.fn(() => Effect.succeed([{
      chatId: "chat-b",
      title: "Agent B",
      status: "running" as const,
      task: "Implement B",
      planStage: null,
      touchedFiles: ["src/b.ts"],
      updatedAt: "2026-01-01T00:00:00Z"
    }]))
    const messagePeerAgent = vi.fn(() =>
      Effect.succeed({ status: "delivered" as const, targetChatId: "chat-b" })
    )
    const registry = createJinglerControlTools(runtimeContext({
      listPeerAgents,
      messagePeerAgent
    }))

    const listed = await Effect.runPromise(registry.execute({
      id: "jingler_list_agents",
      arguments: {},
      role: "conversation",
      mode: "ask"
    }))
    const messaged = await Effect.runPromise(registry.execute({
      id: "jingler_message_agent",
      arguments: { targetChatId: "chat-b", text: "I am editing src/a.ts" },
      role: "conversation",
      mode: "ask"
    }))

    expect(listed.status).toBe("success")
    expect(messaged.status).toBe("success")
    expect(messagePeerAgent).toHaveBeenCalledWith("chat-b", "I am editing src/a.ts")
  })
})

describe("Jingler session completion tool", () => {
  it("publishes completion only from owning top-level roles", async () => {
    const publishEvent = vi.fn(() => Effect.void)
    const registry = createJinglerControlTools(runtimeContext({ publishEvent }))
    const result = await Effect.runPromise(registry.execute({
      id: "jingler_complete_session",
      arguments: {},
      role: "conversation",
      mode: "auto"
    }))
    expect(result.status).toBe("success")
    expect(publishEvent).toHaveBeenCalledWith({ _tag: "SessionCompletionDeclared" })
    expect(registry.capabilitiesFor("background", "auto").map(({ id }) => id))
      .not.toContain("jingler_complete_session")
  })
})

describe("Jingler explanation tool containment", () => {
  it("publishes a typed explanation from the main conversation", async () => {
    const publishExplanation = vi.fn(() => Effect.void)
    const registry = createJinglerControlTools(runtimeContext({ publishExplanation }))
    const explanation: ExplanationPayload = {
      title: "Request flow",
      summary: "One typed path.",
      sections: [{
        id: "flow",
        title: "Flow",
        blocks: [{ kind: "code", id: "tree", language: "text", code: "user\n  agent\n    view" }]
      }]
    }
    const result = await Effect.runPromise(registry.execute({
      id: "jingler_publish_explanation",
      arguments: { explanation },
      role: "conversation",
      mode: "ask"
    }))
    expect(result.status).toBe("success")
    expect(publishExplanation).toHaveBeenCalledWith(explanation)
  })

  it("rejects unsupported explanation blocks before publishing", async () => {
    const publishExplanation = vi.fn(() => Effect.void)
    const registry = createJinglerControlTools(runtimeContext({ publishExplanation }))
    const result = await Effect.runPromise(registry.execute({
      id: "jingler_publish_explanation",
      arguments: {
        explanation: {
          title: "Unsafe",
          summary: "No arbitrary HTML.",
          sections: [{ id: "unsafe", title: "Unsafe", blocks: [{ kind: "html", id: "x", source: "<script />" }] }]
        }
      },
      role: "conversation",
      mode: "ask"
    }))
    expect(result.status).toBe("error")
    expect(publishExplanation).not.toHaveBeenCalled()
  })
})
