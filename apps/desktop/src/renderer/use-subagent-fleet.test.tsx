// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react"
import type { SubagentFleetEvent, SubagentFleetNode } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useSubagentFleet } from "./use-subagent-fleet.js"

vi.mock("./rpc-client.js", () => ({ rpc: { agentControlSubagent: vi.fn() } }))

const node: SubagentFleetNode = {
  id: "parent/run-1",
  subagentId: "run-1",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 10,
  childSequence: 1,
  runId: "run-1",
  parentId: null,
  parentPiSessionId: "parent",
  agent: "worker",
  task: "Review polling",
  model: null,
  status: "running",
  health: "connected",
  phase: null,
  blocking: null,
  terminal: null,
  background: true,
  sessionFile: null,
  currentTool: null,
  startedAt: 10,
  updatedAt: 10,
  completedAt: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationMs: 0,
    toolCalls: 0
  },
  artifacts: [],
  attention: null
}

afterEach(() => {
  cleanup()
})

describe("useSubagentFleet reconciliation", () => {
  it("keeps completed output after its live tab disappears, even without a session file", () => {
    const completed = {
      ...node,
      status: "completed" as const,
      sessionFile: null,
      completedAt: 30,
      updatedAt: 30,
      terminal: {
        reason: "completed" as const,
        summary: "Done",
        at: 30,
        retryable: false
      }
    }
    const events: ReadonlyArray<SubagentFleetEvent> = [{
      _tag: "Upsert",
      version: 2,
      eventId: "complete",
      occurredAt: 30,
      node: completed
    }, {
      _tag: "Remove",
      version: 2,
      eventId: "remove",
      occurredAt: 31,
      registryRevision: 31,
      id: completed.id
    }]
    const { result } = renderHook(() => useSubagentFleet({
      sessionId: "session-1",
      chatId: "chat-1",
      piSessionId: "parent",
      events
    }))

    expect(result.current.nodes).toEqual([])
    expect(result.current.completedNodes).toEqual([completed])
    act(() => result.current.select(completed.id))
    expect(result.current.selectedNode).toEqual(completed)
  })

  it("resolves a workflow selection to its first child when one exists", () => {
    const workflow: SubagentFleetNode = {
      ...node,
      id: "parent/wf-1",
      subagentId: "wf-1",
      runId: "wf-1",
      nodeKind: "workflow",
      agent: "workflow"
    }
    const child: SubagentFleetNode = {
      ...node,
      id: "parent/wf-1-step-1",
      subagentId: "wf-1-step-1",
      runId: "wf-1-step-1",
      parentId: workflow.id
    }
    const events: ReadonlyArray<SubagentFleetEvent> = [workflow, child].map((n, index) => ({
      _tag: "Upsert",
      version: 2,
      eventId: `upsert-${index}`,
      occurredAt: 30 + index,
      node: n
    }))
    const { result } = renderHook(() => useSubagentFleet({
      sessionId: "session-1",
      chatId: "chat-1",
      piSessionId: "parent",
      events
    }))

    act(() => result.current.select(workflow.id))
    expect(result.current.selectedNode).toEqual(child)
  })

  it("resolves a childless workflow selection to the workflow itself, never null", () => {
    // A null resolution silently rendered the MAIN conversation — a dead node
    // with no explanation. The workflow node itself renders a real panel.
    const workflow: SubagentFleetNode = {
      ...node,
      id: "parent/wf-1",
      subagentId: "wf-1",
      runId: "wf-1",
      nodeKind: "workflow",
      agent: "workflow"
    }
    const events: ReadonlyArray<SubagentFleetEvent> = [{
      _tag: "Upsert",
      version: 2,
      eventId: "upsert-wf",
      occurredAt: 30,
      node: workflow
    }]
    const { result } = renderHook(() => useSubagentFleet({
      sessionId: "session-1",
      chatId: "chat-1",
      piSessionId: "parent",
      events
    }))

    act(() => result.current.select(workflow.id))
    expect(result.current.selectedNode).toEqual(workflow)
  })


})
