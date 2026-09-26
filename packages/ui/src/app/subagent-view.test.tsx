import type { Message, SubagentFleetNode } from "@jingler/core"
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
