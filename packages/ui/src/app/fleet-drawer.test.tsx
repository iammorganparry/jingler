import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SubagentFleetNode } from "@jingler/core"
import { FleetDrawer } from "./fleet-drawer.js"

afterEach(cleanup)
const FLEET_BUTTON = /Fleet/

const node = (overrides: Partial<SubagentFleetNode> = {}): SubagentFleetNode => ({
  id: "parent/run-1",
  subagentId: "run-1",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 1,
  childSequence: 1,
  runId: "run-1",
  parentId: null,
  parentPiSessionId: "parent",
  agent: "reviewer",
  task: "Review the capability boundary",
  model: "anthropic/claude-test:high",
  status: "running",
  health: "connected",
  phase: null,
  blocking: null,
  terminal: null,
  background: true,
  sessionFile: "/sessions/reviewer.jsonl",
  currentTool: "workspace_read_file",
  startedAt: 10,
  updatedAt: 20,
  completedAt: null,
  usage: {
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    costUsd: 0.01,
    durationMs: 10_000,
    toolCalls: 2
  },
  artifacts: [{ path: "review.md", label: "Review", kind: "report" }],
  attention: null,
  ...overrides
})

describe("FleetDrawer", () => {
  it("shows hierarchy, telemetry, artifacts, selection, and acknowledged controls", () => {
    const onSelect = vi.fn()
    const onControl = vi.fn()
    const parent = node()
    const child = node({
      id: "parent/run-1/0",
      runId: "run-1:0",
      parentId: parent.id,
      agent: "worker",
      status: "needs-attention",
      attention: {
        requestId: "attention-1",
        reason: "need_decision",
        message: "Which public API should I use?",
        requestedAt: 21,
        deadlineAt: null
      }
    })
    render(
      <FleetDrawer
        nodes={[parent, child]}
        selectedId={child.id}
        expanded
        height={180}
        outcomeMessage="reply acknowledged"
        onSelect={onSelect}
        onToggle={vi.fn()}
        onResize={vi.fn()}
        onControl={onControl}
      />
    )

    expect(screen.getByText("2 active · 2 total")).toBeTruthy()
    expect(screen.getByText("Which public API should I use?")).toBeTruthy()
    expect(screen.getByText("Review")).toBeTruthy()
    fireEvent.click(screen.getByTestId("fleet-agent-run-1"))
    expect(onSelect).toHaveBeenCalledWith(parent.id)
    fireEvent.change(screen.getByLabelText("Reply to agent"), {
      target: { value: "Use the exported bridge" }
    })
    fireEvent.click(screen.getByLabelText("Steer agent"))
    expect(onControl).toHaveBeenCalledWith(
      child,
      "reply",
      "Use the exported bridge",
      "attention-1"
    )
  })

  it("keeps read-only reviewer transcripts visible and preserves legacy close", () => {
    const onDismiss = vi.fn()
    const reviewer = node({ status: "completed" })
    render(
      <FleetDrawer
        nodes={[reviewer]}
        selectedId={reviewer.id}
        expanded
        height={180}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onResize={vi.fn()}
        onControl={vi.fn()}
        canControl={() => false}
        canDismiss={() => true}
        onDismiss={onDismiss}
      />
    )

    expect(screen.getByPlaceholderText("Read-only agent").getAttribute("disabled"))
      .not.toBeNull()
    fireEvent.click(screen.getByLabelText("Close reviewer"))
    expect(onDismiss).toHaveBeenCalledWith(reviewer)
  })

  it("requires an explicit continuation message before resume", () => {
    const onControl = vi.fn()
    const paused = node({ status: "paused" })
    render(
      <FleetDrawer
        nodes={[paused]}
        selectedId={paused.id}
        expanded
        height={180}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onResize={vi.fn()}
        onControl={onControl}
      />
    )

    const resume = screen.getByLabelText("Resume agent")
    expect(resume.getAttribute("disabled")).not.toBeNull()
    expect(resume.getAttribute("title")).toBe("Enter a continuation message to resume")
    fireEvent.change(screen.getByPlaceholderText("Steer agent…"), {
      target: { value: "Continue from the persisted session" }
    })
    expect(resume.getAttribute("disabled")).toBeNull()
    fireEvent.click(resume)
    expect(onControl).toHaveBeenCalledWith(
      paused,
      "resume",
      "Continue from the persisted session",
      undefined
    )
  })

  it("uses the composer's chrome instead of drawing a detached card", () => {
    render(
      <FleetDrawer
        nodes={[node()]}
        selectedId="main"
        expanded={false}
        height={180}
        embedded
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onResize={vi.fn()}
        onControl={vi.fn()}
      />
    )
    const drawer = screen.getByTestId("fleet-drawer")
    expect(drawer.getAttribute("data-embedded")).toBe("true")
    expect(drawer.className).not.toContain("rounded-xl")
    expect(drawer.className).not.toContain("border-line")
  })

  it("collapses to one composer-adjacent summary row", () => {
    render(
      <FleetDrawer
        nodes={[node()]}
        selectedId="main"
        expanded={false}
        height={180}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onResize={vi.fn()}
        onControl={vi.fn()}
      />
    )
    expect(screen.getByRole("button", { name: FLEET_BUTTON }).getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByTestId("fleet-agent-main")).toBeNull()
  })
})
