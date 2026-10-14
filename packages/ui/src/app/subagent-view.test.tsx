import type { Message, ProviderId, SubagentFleetNode } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { FleetAgentView } from "./subagent-view.js"

const NOT_AVAILABLE = /not available yet/
const ORCHESTRATES = /orchestrates other agents/

const fleetNode = (over: Partial<SubagentFleetNode> = {}): SubagentFleetNode => ({
  id: "parent/run-1",
  subagentId: "run-1",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 1,
  childSequence: 1,
  runId: "run-1",
  parentId: null,
  parentRuntimeSessionId: "parent",
  agent: "scout",
  task: "Map the UI",
  model: "anthropic/claude-test",
  status: "running",
  health: "connected",
  phase: null,
  blocking: null,
  terminal: null,
  background: true,
  sessionFile: null,
  currentTool: "workspace_read_file",
  startedAt: 10,
  updatedAt: 20,
  completedAt: null,
  usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, costUsd: 0, durationMs: 10_000, toolCalls: 2 },
  artifacts: [],
  attention: null,
  workspace: null,
  prNumber: null,
  ...over
})

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(cleanup)
afterAll(() => vi.unstubAllGlobals())

describe("FleetAgentView", () => {
  it("renders child tool calls as expandable tool components", () => {
    const message: Message = {
      id: "child-1",
      role: "assistant",
      streaming: false,
      createdAt: "2026-08-16T11:14:28.000Z",
      parts: [{
        _tag: "Tool",
        tool: {
          id: "tool-1",
          name: "command_execute",
          target: "pnpm test",
          status: "success",
          meta: "exit 0",
          diff: null,
          preview: null,
          output: "18 tests passed"
        }
      }]
    }

    render(<FleetAgentView messages={[message]} />)

    expect(screen.getAllByText("pnpm test").length).toBeGreaterThan(0)
    expect(screen.getByRole("region", { hidden: true }).getAttribute("aria-hidden")).toBe("true")
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByRole("log").textContent).toContain("18 tests passed")
  })

  it("shows live activity for a running child with no transcript, not a dead 'not available' line", () => {
    render(<FleetAgentView node={fleetNode()} messages={[]} />)

    expect(screen.getByTestId("fleet-agent-live")).toBeDefined()
    expect(screen.getByText("Working…")).toBeDefined()
    expect(screen.getByText("Using workspace_read_file")).toBeDefined()
    expect(screen.queryByText(NOT_AVAILABLE)).toBeNull()
  })

  it("shows rejected control delivery", () => {
    render(
      <FleetAgentView
        node={fleetNode()}
        messages={[]}
        controlOutcome={{
          version: 2,
          requestId: "request-1",
          runId: "run-1",
          action: "steer",
          acknowledged: false,
          status: "rejected",
          deliveryStatus: "rejected",
          sequence: 1,
          nativeRequestId: null,
          message: "Agent is no longer running",
          acknowledgedAt: 30
        }}
      />
    )

    expect(screen.getByRole("alert").textContent).toContain("Agent is no longer running")
  })

  it("shows supervisor attention above an existing transcript", () => {
    const message: Message = {
      id: "child-1",
      role: "assistant",
      streaming: false,
      createdAt: "2026-08-16T11:14:28.000Z",
      parts: [{ _tag: "Text", text: "Reviewing the code." }]
    }
    render(
      <FleetAgentView
        node={fleetNode({
          status: "needs-attention",
          attention: {
            requestId: "request-1",
            reason: "need_decision",
            message: "Should I include accessibility behavior?",
            requestedAt: 30,
            deadlineAt: null
          }
        })}
        messages={[message]}
      />
    )

    expect(screen.getByTestId("subagent-attention").textContent).toContain(
      "Should I include accessibility behavior?"
    )
  })

  it("shows final output after a partial transcript", () => {
    const message: Message = {
      id: "child-1",
      role: "assistant",
      streaming: false,
      createdAt: "2026-08-16T11:14:28.000Z",
      parts: [{ _tag: "Text", text: "Inspected the code." }]
    }
    render(
      <FleetAgentView
        node={fleetNode({
          status: "completed",
          currentTool: null,
          completedAt: 30,
          terminal: {
            reason: "completed",
            summary: "No blockers. Validation passed.",
            at: 30,
            retryable: false
          }
        })}
        messages={[message]}
      />
    )

    expect(screen.getByText("Inspected the code.")).toBeDefined()
    expect(screen.getByTestId("subagent-final-output").textContent).toContain(
      "No blockers. Validation passed."
    )
  })

  it("shows a completed worker's final output when no transcript was recorded", () => {
    render(
      <FleetAgentView
        node={fleetNode({
          agent: "worker",
          status: "completed",
          currentTool: null,
          completedAt: 30,
          terminal: {
            reason: "completed",
            summary: "Implemented the tab lifecycle.\nValidation: 12 tests passed.",
            at: 30,
            retryable: false
          }
        })}
        messages={[]}
      />
    )

    expect(screen.getByTestId("subagent-final-output").textContent).toContain(
      "Validation: 12 tests passed."
    )
  })

  it("still shows the plain fallback when there is no fleet node at all", () => {
    render(<FleetAgentView messages={[]} />)

    expect(screen.getByText(NOT_AVAILABLE)).toBeDefined()
    expect(screen.queryByTestId("fleet-agent-live")).toBeNull()
  })

})

describe("FleetAgentView workflow nodes", () => {
  it("explains a live workflow node instead of promising a transcript", () => {
    render(
      <FleetAgentView
        node={fleetNode({ nodeKind: "workflow", agent: "workflow", currentTool: null })}
        messages={[]}
      />
    )

    expect(screen.getByText(ORCHESTRATES)).toBeDefined()
    expect(screen.queryByTestId("workflow-outcome")).toBeNull()
    expect(screen.queryByText(NOT_AVAILABLE)).toBeNull()
    expect(screen.queryByTestId("fleet-agent-live")).toBeNull()
  })

  it("shows a settled workflow's terminal outcome, not an empty pane", () => {
    render(
      <FleetAgentView
        node={fleetNode({
          nodeKind: "workflow",
          agent: "workflow",
          status: "completed",
          currentTool: null,
          completedAt: 30,
          terminal: {
            reason: "completed",
            summary: "Reviewed the PR across 3 step agents.",
            at: 30,
            retryable: false
          }
        })}
        messages={[]}
      />
    )

    expect(screen.getByTestId("workflow-outcome").textContent).toBe(
      "Workflow completed: Reviewed the PR across 3 step agents."
    )
    expect(screen.getByText(ORCHESTRATES)).toBeDefined()
  })
})

describe("SubagentMetaStrip", () => {
  const full = fleetNode({
    phase: "scanning",
    usage: { inputTokens: 12_400, outputTokens: 900, totalTokens: 13_300, costUsd: 0.42, durationMs: 10_000, toolCalls: 7 },
    artifacts: [{ kind: "report", path: "/tmp/out/report.md", label: "report.md" }]
  })

  it("renders every field from the node", () => {
    const onOpen = vi.fn()
    render(<FleetAgentView node={full} messages={[]} providerId={"anthropic" as ProviderId} onOpenArtifact={onOpen} />)
    const identity = screen.getByTestId("subagent-meta-identity").textContent
    expect(identity).toContain("anthropic/claude-test")
    expect(identity).toContain("running · scanning")
    const usage = screen.getByTestId("subagent-meta-usage").textContent
    expect(usage).toContain("workspace_read_file")
    expect(usage).toContain("12.4k in / 900 out")
    expect(usage).toContain("7 tool calls")
    expect(usage).toContain("$0.42")
    expect(usage).toContain("Background")
    fireEvent.click(screen.getByRole("button", { name: "report.md" }))
    expect(onOpen).toHaveBeenCalledWith("/tmp/out/report.md")
  })

  it("omits null and zero fields instead of showing a dash", () => {
    render(
      <FleetAgentView
        node={fleetNode({
          model: null,
          currentTool: null,
          background: false,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0 }
        })}
        messages={[]}
      />
    )
    const strip = screen.getByTestId("subagent-meta-strip")
    expect(screen.queryByTestId("subagent-meta-usage")).toBeNull()
    expect(screen.queryByTestId("subagent-meta-artifacts")).toBeNull()
    expect(strip.textContent).not.toContain("—")
    expect(strip.textContent).not.toContain("$")
    expect(strip.textContent).not.toContain("Background")
  })

  it("keeps the cost out of the strip when it is zero", () => {
    render(<FleetAgentView node={fleetNode()} messages={[]} />)
    expect(screen.getByTestId("subagent-meta-usage").textContent).not.toContain("$")
  })

  it("expands Details with run id and started time", () => {
    render(<FleetAgentView node={full} messages={[]} />)
    expect(screen.queryByTestId("subagent-meta-details")).toBeNull()
    fireEvent.click(screen.getByTestId("subagent-meta-details-toggle"))
    const details = screen.getByTestId("subagent-meta-details").textContent
    expect(details).toContain("Run")
    expect(details).toContain("run-1")
    expect(details).toContain("Started")
  })

  it("truncates tool text but never the pills", () => {
    render(<FleetAgentView node={full} messages={[]} />)
    expect(screen.getByText("workspace_read_file").className).toContain("truncate")
    expect(screen.getByText("Background").closest(".whitespace-nowrap")).not.toBeNull()
  })
})

describe("FleetAgentView task", () => {
  it("renders the task as the first, quoted item in the transcript", () => {
    const message: Message = {
      id: "child-1",
      role: "assistant",
      streaming: false,
      createdAt: "2026-08-16T11:14:28.000Z",
      parts: [{ _tag: "Text", text: "Reviewing the code." }]
    }
    render(<FleetAgentView node={fleetNode({ task: "Map the UI" })} messages={[message]} />)
    const scroll = screen.getByTestId("fleet-agent-transcript-scroll")
    const task = screen.getByTestId("subagent-task")
    expect(task.tagName).toBe("BLOCKQUOTE")
    expect(task.textContent).toBe("Map the UI")
    expect(scroll.querySelector("blockquote")).toBe(task)
    expect(task.compareDocumentPosition(screen.getByText("Reviewing the code.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("omits the quoted task when there is no fleet node", () => {
    render(<FleetAgentView messages={[]} />)
    expect(screen.queryByTestId("subagent-task")).toBeNull()
  })
})

describe("FleetAgentView states", () => {
  it("shows a loading skeleton while the child transcript loads", () => {
    render(<FleetAgentView node={fleetNode()} messages={[]} loading />)
    expect(screen.getAllByRole("status", { name: "Loading" }).length).toBe(3)
    expect(screen.queryByTestId("fleet-agent-live")).toBeNull()
  })

  it("names an orchestrator as having no transcript", () => {
    render(<FleetAgentView node={fleetNode({ nodeKind: "workflow", agent: "workflow", currentTool: null })} messages={[]} />)
    expect(screen.getByText("This agent has no transcript (orchestrator)")).toBeDefined()
  })

  it("shows the load error with a working Retry", () => {
    const onRetry = vi.fn()
    render(<FleetAgentView node={fleetNode()} messages={[]} error="Could not load the child transcript." onRetry={onRetry} />)
    expect(screen.getByRole("alert").textContent).toContain("Could not load the child transcript.")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("omits Retry when no handler is given", () => {
    render(<FleetAgentView node={fleetNode()} messages={[]} error="boom" />)
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })
})
