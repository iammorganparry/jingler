// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentEndpointId } from "@jingler/core"
import type { Session, SubagentFleetEvent, SubagentFleetNode, SubagentFleetSnapshot } from "@jingler/core"
import {
  emptySubagentRunTree,
  reduceSubagentFleetEvent
} from "@jingler/cli-adapters/runtime/subagents/subagent-run-tree-reducer"
import {
  __debugActorCount,
  disposeConversationActor,
  fleetRecoveryEvents,
  fleetRetryDecision,
  getConversationActor
} from "./conversation-registry.js"

import { setVisibleSessionIds } from "./active-session.js"

const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }))
vi.mock("./rpc-client.js", () => ({
  rpc: {
    agentSubagentFleetSnapshot: mocks.snapshot,
    sessionsTranscriptPage: vi.fn(async () => ({ messages: [], hasMore: false, cursor: null })),
    planCurrent: vi.fn(async () => null),
    agentChatBusy: vi.fn(async () => false),
    workspaceFiles: vi.fn(async () => []),
    sessionsDiffStat: vi.fn(async () => ({ added: 0, removed: 0, files: 0 })),
    skillsList: vi.fn(async () => []),
    reviewWatch: vi.fn(() => () => {})
  }
}))

const node: SubagentFleetNode = {
  id: "parent/run-1",
  subagentId: "run-1",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 10,
  childSequence: 1,
  runId: "run-1",
  parentId: null,
  parentRuntimeSessionId: "parent",
  agent: "worker",
  task: "Test recovery",
  model: null,
  status: "running",
  health: "connected",
  phase: null,
  blocking: { reason: "tool", message: "Waiting", since: 9 },
  terminal: null,
  background: true,
  sessionFile: null,
  currentTool: "read",
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

const upsert: SubagentFleetEvent = {
  _tag: "Upsert",
  version: 2,
  eventId: "running",
  occurredAt: 10,
  node
}

const snapshot = (over: Partial<SubagentFleetSnapshot> = {}): SubagentFleetSnapshot => ({
  version: 2,
  parentRuntimeSessionId: "parent",
  registryRevision: 20,
  generatedAt: 20,
  totalActive: 0,
  omitted: 0,
  activeCapacity: { used: 0, limit: 8 },
  nodes: [],
  ...over
})

const tree = (...events: ReadonlyArray<SubagentFleetEvent>) =>
  events.reduce(reduceSubagentFleetEvent, emptySubagentRunTree("parent"))

const endpointId = AgentEndpointId.make("desktop:pi:test")

const session = {
  id: "session-1",
  repo: "jingler",
  branch: "test",
  title: "Recovery",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-10T00:00:00.000Z",
  activeChatId: "chat-1",
  chats: [{
    id: "chat-1",
    title: "Main",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    runtimeId: "pi",
    endpointId,
    continuation: { runtimeId: "pi", endpointId, id: "parent" }
  }],
  mode: "auto"
} as Session

afterEach(() => {
  disposeConversationActor(session.id)
  disposeConversationActor("old-visible")
  setVisibleSessionIds(new Set())
  mocks.snapshot.mockReset()
  vi.useRealTimers()
})

describe("conversation registry fleet recovery", () => {
  it("keeps newly mounted sibling actors alive until session visibility commits", async () => {
    vi.useFakeTimers()
    const chats = Array.from({ length: 6 }, (_, i) => ({ id: `chat-${i}`, title: `Chat ${i}`, createdAt: session.updatedAt, updatedAt: session.updatedAt }))
    const old = { ...session, id: "old-visible", chats }
    setVisibleSessionIds(new Set([old.id]))
    for (const chat of chats) getConversationActor(old, chat.id)
    const next = { ...session, chats: chats.slice(0, 3) }
    const actors = next.chats.map((chat) => getConversationActor(next, chat.id))
    expect(actors.every((actor) => actor.getSnapshot().status === "active")).toBe(true)
    setVisibleSessionIds(new Set([next.id]))
    await vi.advanceTimersByTimeAsync(200)
    expect(actors.every((actor) => actor.getSnapshot().status === "active" && actor.getSnapshot().context.loaded)).toBe(true)
    expect(__debugActorCount()).toBeLessThanOrEqual(6)
  })

  it("persists unknown recovery after four inactive RPC failures", async () => {
    vi.useFakeTimers()
    mocks.snapshot.mockRejectedValue(new Error("Pi session is not active"))
    const actor = getConversationActor(session)
    actor.send({ type: "RECOVER_SUBAGENT_FLEET", events: [upsert] })

    await vi.advanceTimersByTimeAsync(5_500)

    expect(mocks.snapshot).toHaveBeenCalledTimes(4)
    expect(actor.getSnapshot().context.subagentFleetEvents.some((event) =>
      event._tag === "Upsert" && event.node.id === node.id && event.node.status === "unknown"
    )).toBe(true)
  })

  it("restores a durable native terminal Snapshot before a new parent turn", async () => {
    vi.useFakeTimers()
    const terminalNode: SubagentFleetNode = {
      ...node,
      registryRevision: 21,
      status: "completed",
      health: "disconnected",
      blocking: null,
      currentTool: null,
      updatedAt: 21,
      completedAt: 21,
      terminal: { reason: "completed", summary: "Recovered after restart", at: 21, retryable: false }
    }
    mocks.snapshot.mockResolvedValue(snapshot({ registryRevision: 21, nodes: [terminalNode] }))
    const nativeEndpoint = AgentEndpointId.make("desktop:codex:default")
    const nativeSession = {
      ...session,
      chats: [{
        ...session.chats[0]!,
        runtimeId: "codex" as const,
        endpointId: nativeEndpoint,
        continuation: { runtimeId: "codex" as const, endpointId: nativeEndpoint, id: "codex-parent" }
      }]
    }
    const actor = getConversationActor(nativeSession)
    actor.send({ type: "RECOVER_SUBAGENT_FLEET", events: [upsert] })

    await vi.advanceTimersByTimeAsync(500)

    expect(mocks.snapshot).toHaveBeenCalledWith("session-1", "chat-1", "parent")
    expect(actor.getSnapshot().context.subagentFleetEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        _tag: "Upsert",
        node: expect.objectContaining({ status: "completed", terminal: terminalNode.terminal })
      })
    ]))
  })

  it("reconciles immediately when the window regains focus", async () => {
    vi.useFakeTimers()
    mocks.snapshot.mockResolvedValue(snapshot())
    const actor = getConversationActor(session)
    actor.send({ type: "RECOVER_SUBAGENT_FLEET", events: [upsert] })
    await vi.advanceTimersByTimeAsync(500)
    const beforeFocus = mocks.snapshot.mock.calls.length
    expect(beforeFocus).toBeGreaterThan(0)

    window.dispatchEvent(new Event("focus"))
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.snapshot).toHaveBeenCalledTimes(beforeFocus + 1)
  })

  it("settles only after four consecutive inactive-session failures", () => {
    let retry = { retryAttempt: 0, inactiveAttempts: 0 }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const decision = fleetRetryDecision(
        retry.retryAttempt,
        retry.inactiveAttempts,
        new Error("Pi session is not active: parent")
      )
      retry = decision
      expect(decision.exhaustedInactive).toBe(attempt === 3)
    }
  })

  it("does not settle a mixed failure sequence", () => {
    const causes = [
      new Error("Pi session is not active"),
      new Error("Pi session is not active"),
      new Error("Connection reset"),
      new Error("Pi session is not active")
    ]
    let retry = { retryAttempt: 0, inactiveAttempts: 0 }
    let exhausted = false
    for (const cause of causes) {
      const decision = fleetRetryDecision(retry.retryAttempt, retry.inactiveAttempts, cause)
      retry = decision
      exhausted ||= decision.exhaustedInactive
    }
    expect(exhausted).toBe(false)
  })

  it("settles missing active nodes without retaining blocking state", () => {
    const recovered = fleetRecoveryEvents(tree(upsert), snapshot())

    expect(recovered).toMatchObject([{
      _tag: "Upsert",
      node: {
        id: node.id,
        status: "unknown",
        blocking: null,
        currentTool: null,
        registryRevision: 20
      }
    }])
  })

  it("does not settle nodes from a stale snapshot", () => {
    const newer = { ...node, registryRevision: 30, updatedAt: 30 }
    const event: SubagentFleetEvent = { ...upsert, eventId: "newer", node: newer }

    expect(fleetRecoveryEvents(tree(event), snapshot({ registryRevision: 20 }))).toEqual([])
  })

  it("does not settle nodes omitted from a truncated snapshot", () => {
    expect(fleetRecoveryEvents(tree(upsert), snapshot({ omitted: 1 }))).toEqual([])
  })

  it("rejects remote nodes hidden by a newer tombstone", () => {
    const removed: SubagentFleetEvent = {
      _tag: "Remove",
      version: 2,
      eventId: "removed",
      occurredAt: 20,
      registryRevision: 20,
      id: node.id
    }
    const remote = snapshot({
      totalActive: 1,
      activeCapacity: { used: 1, limit: 8 },
      nodes: [{ ...node, registryRevision: 15, updatedAt: 15 }]
    })

    expect(fleetRecoveryEvents(tree(upsert, removed), remote)).toEqual([])
  })
})
