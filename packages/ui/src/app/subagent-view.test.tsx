import type { Message, SubagentFleetNode } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { FleetAgentView } from "./subagent-view.js"

const NOT_AVAILABLE = /not available yet/
const TOOL_RESULT = /Tool result \(command_execute\)/

const fleetNode = (over: Partial<SubagentFleetNode> = {}): SubagentFleetNode => ({
  id: "parent/run-1",
  subagentId: "run-1",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 1,
  childSequence: 1,
  runId: "run-1",
  parentId: null,
  parentPiSessionId: "parent",
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

    expect(screen.getByText("pnpm test")).toBeDefined()
    expect(screen.queryByText(TOOL_RESULT)).toBeNull()
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByText("18 tests passed")).toBeDefined()
  })

  it("shows live activity for a running child with no transcript, not a dead 'not available' line", () => {
    render(<FleetAgentView node={fleetNode()} messages={[]} />)

    expect(screen.getByTestId("fleet-agent-live")).toBeDefined()
    expect(screen.getByText("Working…")).toBeDefined()
    expect(screen.getByText("Using workspace_read_file")).toBeDefined()
    expect(screen.queryByText(NOT_AVAILABLE)).toBeNull()
  })

  it("still shows the plain fallback when there is no fleet node at all", () => {
    render(<FleetAgentView messages={[]} />)

    expect(screen.getByText(NOT_AVAILABLE)).toBeDefined()
    expect(screen.queryByTestId("fleet-agent-live")).toBeNull()
  })
})
