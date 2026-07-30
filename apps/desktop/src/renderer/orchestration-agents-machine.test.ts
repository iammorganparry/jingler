import type {
  CliKind,
  StreamEvent,
  WorkerActivity,
  WorkerIdentity,
  WorkerLifecycleStatus,
  WorkerState
} from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import {
  orchestrationAgentsMachine,
  type OrchestrationAgentsScope
} from "./orchestration-agents-machine.js"

const scope = (
  planId = "plan-1",
  chatId = "chat-1"
): OrchestrationAgentsScope => ({
  sessionId: "session-1",
  planId,
  chatId
})

const worker = (
  agentId: string,
  harness: CliKind,
  overrides: {
    readonly attempt?: number
    readonly planId?: string
    readonly chatId?: string
  } = {}
): WorkerIdentity => ({
  sessionId: "session-1",
  planId: overrides.planId ?? "plan-1",
  producingChatId: overrides.chatId ?? "chat-1",
  agentId,
  stageIds: [agentId === "agent-a" ? "01" : "02"],
  harness,
  model: harness === "claude" ? "opus" : "gpt-5.6-sol",
  attempt: overrides.attempt ?? 1
})

const state = (
  identity: WorkerIdentity,
  status: WorkerLifecycleStatus,
  message: string | null = null
): WorkerState => ({ worker: identity, status, message })

const reset = (
  workers: ReadonlyArray<WorkerState>,
  planId = "plan-1",
  chatId = "chat-1"
): WorkerActivity => ({
  _tag: "Reset",
  sessionId: "session-1",
  planId,
  producingChatId: chatId,
  workers
})

const lifecycle = (
  identity: WorkerIdentity,
  status: WorkerLifecycleStatus,
  message: string | null = null
): WorkerActivity => ({
  _tag: "State",
  worker: identity,
  status,
  message
})

const harnessEvent = (
  identity: WorkerIdentity,
  event: StreamEvent
): WorkerActivity => ({
  _tag: "HarnessEvent",
  worker: identity,
  stageId: identity.stageIds[0] ?? "01",
  event
})

const textOf = (activity: {
  readonly message: {
    readonly parts: ReadonlyArray<{ readonly _tag: string; readonly text?: string }>
  }
}): string =>
  activity.message.parts
    .filter((part) => part._tag === "Text")
    .map((part) => part.text ?? "")
    .join("")

const makeHarness = () => {
  const subscriptions: Array<{
    readonly scope: OrchestrationAgentsScope
    readonly listener: (activity: WorkerActivity) => void
    readonly cancel: ReturnType<typeof vi.fn>
  }> = []
  const subscribe = vi.fn(
    (
      watched: OrchestrationAgentsScope,
      listener: (activity: WorkerActivity) => void
    ) => {
      const cancel = vi.fn()
      subscriptions.push({ scope: watched, listener, cancel })
      return cancel
    }
  )
  return { subscriptions, subscribe }
}

const start = (
  watchedScope: OrchestrationAgentsScope | null,
  subscribe: ReturnType<typeof makeHarness>["subscribe"]
) =>
  createActor(orchestrationAgentsMachine, {
    input: { scope: watchedScope, subscribe }
  }).start()

describe("orchestrationAgentsMachine", () => {
  it("keeps parallel worker attempts, lifecycle, harnesses, and messages independent", async () => {
    const harness = makeHarness()
    const actor = start(scope(), harness.subscribe)
    await waitFor(actor, (snapshot) => snapshot.matches("watching"))
    const emit = harness.subscriptions[0]!.listener
    const agentA = worker("agent-a", "claude")
    const agentB = worker("agent-b", "codex")

    emit(reset([state(agentA, "queued"), state(agentB, "queued")]))
    emit(lifecycle(agentA, "running"))
    emit(lifecycle(agentB, "running"))
    emit(harnessEvent(agentA, { _tag: "Assistant", text: "alpha" }))
    emit(harnessEvent(agentB, { _tag: "Assistant", text: "bravo" }))
    emit(lifecycle(agentA, "completed"))
    // The harness crashed without a Failed event. Authoritative lifecycle must
    // still stop the renderer's streaming indicator.
    emit(lifecycle(agentB, "failed", "worker process exited"))

    const beforeRetry = actor.getSnapshot().context.agents
    expect(beforeRetry).toHaveLength(2)
    expect(beforeRetry.map(({ id, status, harness, attempt }) => ({
      id,
      status,
      harness,
      attempt
    }))).toStrictEqual([
      { id: "agent-a", status: "completed", harness: "claude", attempt: 1 },
      { id: "agent-b", status: "failed", harness: "codex", attempt: 1 }
    ])
    expect(textOf(beforeRetry[0]!)).toBe("alpha")
    expect(textOf(beforeRetry[1]!)).toBe("bravo")
    expect(beforeRetry.every((agent) => !agent.message.streaming)).toBe(true)

    const retriedA = worker("agent-a", "claude", { attempt: 2 })
    emit(reset([state(retriedA, "queued")]))
    emit(lifecycle(retriedA, "running"))
    emit(harnessEvent(retriedA, { _tag: "Assistant", text: "alpha retry" }))

    const afterRetry = actor.getSnapshot().context.agents
    expect(afterRetry[0]!.attempt).toBe(2)
    expect(textOf(afterRetry[0]!)).toBe("alpha retry")
    expect(afterRetry[1]).toBe(beforeRetry[1])
    expect(textOf(afterRetry[1]!)).toBe("bravo")

    // A late callback from the settled first attempt cannot roll the retry back.
    emit(harnessEvent(agentA, { _tag: "Assistant", text: " stale" }))
    emit(lifecycle(agentA, "failed", "old attempt failed late"))
    expect(actor.getSnapshot().context.agents[0]).toStrictEqual(afterRetry[0])
    actor.stop()
  })

  it("reconstructs replay without duplicating assistant text or tool calls", async () => {
    const agentA = worker("agent-a", "claude")
    const activities: ReadonlyArray<WorkerActivity> = [
      reset([state(agentA, "queued")]),
      lifecycle(agentA, "running"),
      harnessEvent(agentA, { _tag: "Started", sessionId: "worker-session" }),
      harnessEvent(agentA, { _tag: "Assistant", text: "hello " }),
      harnessEvent(agentA, { _tag: "Assistant", text: "world" }),
      harnessEvent(agentA, {
        _tag: "ToolStart",
        id: "tool-1",
        name: "Read",
        target: "src/a.ts"
      }),
      harnessEvent(agentA, {
        _tag: "ToolEnd",
        id: "tool-1",
        status: "success",
        meta: null,
        diff: null,
        preview: null
      }),
      lifecycle(agentA, "completed")
    ]

    const earlyHarness = makeHarness()
    const early = start(scope(), earlyHarness.subscribe)
    await waitFor(early, (snapshot) => snapshot.matches("watching"))
    for (const activity of activities) {
      earlyHarness.subscriptions[0]!.listener(activity)
    }
    const earlyAgents = early.getSnapshot().context.agents

    const lateHarness = makeHarness()
    const late = start(scope(), lateHarness.subscribe)
    await waitFor(late, (snapshot) => snapshot.matches("watching"))
    for (const activity of activities) {
      lateHarness.subscriptions[0]!.listener(activity)
    }
    expect(late.getSnapshot().context.agents).toStrictEqual(earlyAgents)

    // A reconnect replays from Reset. Applying that replay to an already-built
    // projection must rebuild, not append the same text/tool a second time.
    for (const activity of activities) {
      lateHarness.subscriptions[0]!.listener(activity)
    }
    const replayed = late.getSnapshot().context.agents
    expect(replayed).toStrictEqual(earlyAgents)
    expect(textOf(replayed[0]!)).toBe("hello world")
    expect(replayed[0]!.message.parts.filter((part) => part._tag === "Tool")).toHaveLength(1)

    early.stop()
    late.stop()
  })

  it("clears stale workers and cancels the old subscription when plan or chat changes", async () => {
    const harness = makeHarness()
    const actor = start(scope(), harness.subscribe)
    await waitFor(actor, (snapshot) => snapshot.matches("watching"))
    const first = harness.subscriptions[0]!
    first.listener(reset([state(worker("agent-a", "claude"), "running")]))
    expect(actor.getSnapshot().context.agents.map((agent) => agent.id)).toStrictEqual(["agent-a"])

    actor.send({ type: "SCOPE_CHANGED", scope: scope() })
    expect(harness.subscribe).toHaveBeenCalledTimes(1)
    expect(first.cancel).not.toHaveBeenCalled()

    actor.send({ type: "SCOPE_CHANGED", scope: scope("plan-2") })
    await waitFor(
      actor,
      () => harness.subscriptions.length === 2
    )
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(actor.getSnapshot().context.agents).toStrictEqual([])

    // A callback racing its cancellation cannot leak the prior plan back in.
    first.listener(reset([state(worker("agent-a", "claude"), "running")]))
    expect(actor.getSnapshot().context.agents).toStrictEqual([])

    const second = harness.subscriptions[1]!
    second.listener(
      reset(
        [state(worker("agent-b", "codex", { planId: "plan-2" }), "running")],
        "plan-2"
      )
    )
    expect(actor.getSnapshot().context.agents.map((agent) => agent.id)).toStrictEqual(["agent-b"])

    actor.send({ type: "SCOPE_CHANGED", scope: scope("plan-2", "chat-2") })
    await waitFor(
      actor,
      () => harness.subscriptions.length === 3
    )
    expect(second.cancel).toHaveBeenCalledOnce()
    expect(actor.getSnapshot().context.agents).toStrictEqual([])

    const third = harness.subscriptions[2]!
    actor.send({ type: "SCOPE_CHANGED", scope: null })
    await waitFor(actor, (snapshot) => snapshot.matches("idle"))
    expect(third.cancel).toHaveBeenCalledOnce()
    expect(actor.getSnapshot().context.scope).toBeNull()
    expect(actor.getSnapshot().context.agents).toStrictEqual([])
    actor.stop()
  })
})
