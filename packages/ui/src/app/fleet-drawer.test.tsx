import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SubagentFleetNode } from "@jingler/core"
import { FleetDrawer, SubagentCompletionLinks } from "./fleet-drawer.js"

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
        outcome={{
          version: 2,
          requestId: "reply-1",
          runId: child.runId,
          action: "reply",
          acknowledged: true,
          status: "accepted",
          deliveryStatus: "delivered",
          sequence: 1,
          nativeRequestId: "native-reply-1",
          message: "reply delivered",
          acknowledgedAt: 22
        }}
        onSelect={onSelect}
        onToggle={vi.fn()}
        onResize={vi.fn()}
        onControl={onControl}
      />
    )

    expect(screen.getByText("2 active · 2 total")).toBeTruthy()
    expect(screen.getByText("Which public API should I use?")).toBeTruthy()
    expect(screen.getByText("Review")).toBeTruthy()
    expect(screen.getByTestId("fleet-control-receipt").textContent).toBe("delivered")
    fireEvent.click(screen.getByTestId("fleet-agent-run-1"))
    expect(onSelect).toHaveBeenCalledWith(parent.id)
    // No mini steer input: the real composer below the child view is the one
    // way to message a selected agent. Lifecycle controls remain.
    expect(screen.queryByLabelText("Reply to agent")).toBeNull()
    expect(screen.queryByLabelText("Steer agent")).toBeNull()
    expect(screen.getByLabelText("Interrupt agent")).toBeTruthy()
    expect(onControl).not.toHaveBeenCalled()
  })

  it("drops a single-child workflow container so its one step is not shown twice", () => {
    const workflow = node({
      id: "parent/wf",
      runId: "wf",
      nodeKind: "workflow",
      agent: "REVIEWER",
      task: "Active delegated work"
    })
    const step = node({
      id: "parent/wf/0",
      runId: "wf:0",
      parentId: workflow.id,
      agent: "reviewer",
      task: "Review the diff"
    })
    render(
      <FleetDrawer
        nodes={[workflow, step]}
        selectedId={step.id}
        expanded
        height={180}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onResize={vi.fn()}
        onControl={vi.fn()}
      />
    )

    // The container is redundant with its child in a flat grid — only the child shows.
    expect(screen.queryByTestId("fleet-workflow-wf")).toBeNull()
    expect(screen.getByTestId("fleet-agent-wf:0")).toBeTruthy()
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

    expect(screen.queryByPlaceholderText("Read-only agent")).toBeNull()
    fireEvent.click(screen.getByLabelText("Close reviewer"))
    expect(onDismiss).toHaveBeenCalledWith(reviewer)
  })

  it("keeps Stop for a paused agent and leaves resume to the composer", () => {
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

    // Resume moved to the composer (it needs a continuation message, and the
    // composer is where messages are typed). The drawer keeps Stop for a
    // paused agent and offers no resume button of its own.
    expect(screen.queryByLabelText("Resume agent")).toBeNull()
    fireEvent.click(screen.getByLabelText("Stop agent"))
    expect(onControl).toHaveBeenCalledWith(paused, "stop")
  })

  it("keeps bounded completion transcript and artifact links outside Fleet chrome", () => {
    const onSelect = vi.fn()
    const onOpenArtifact = vi.fn()
    const completed = node({ status: "completed", currentTool: null })
    const artifactOnly = node({
      id: "parent/run-2",
      subagentId: "run-2",
      runId: "run-2",
      agent: "archiver",
      status: "completed",
      currentTool: null,
      sessionFile: null,
      artifacts: [{ path: "archive.md", label: "Archive", kind: "report" }]
    })
    render(
      <SubagentCompletionLinks
        nodes={[completed, artifactOnly]}
        selectedId="main"
        onSelect={onSelect}
        onOpenArtifact={onOpenArtifact}
      />
    )

    expect(screen.queryByTestId("fleet-drawer")).toBeNull()
    fireEvent.click(screen.getByText("reviewer transcript"))
    fireEvent.click(screen.getByText("Review"))
    fireEvent.click(screen.getByText("Archive"))
    expect(screen.queryByText("archiver transcript")).toBeNull()
    expect(onSelect).toHaveBeenCalledWith(completed.id)
    expect(onOpenArtifact).toHaveBeenCalledWith("review.md")
    expect(onOpenArtifact).toHaveBeenCalledWith("archive.md")
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
