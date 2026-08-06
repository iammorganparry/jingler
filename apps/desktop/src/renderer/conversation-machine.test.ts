import type { Message, Plan, PlanDocument, Session, StreamEvent } from "@jingler/core"
import {
  applyStreamEvent,
  assistantMessage,
  latestPlan,
  STOPPED_NOTE,
  userMessage
} from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { conversationMachine } from "./conversation-machine.js"

/**
 * The renderer's conversation flow is a deterministic XState chart. Its only
 * side-effects go through `rpc-client`, which we mock — so the machine runs under
 * node with no Electron/`window`. We drive it through the same events the view
 * sends and assert the OUTCOMES the operator sees: a mid-run send is queued and
 * replayed, the Changes rail refreshes live on an edit, images ride along on the
 * turn, and Stop abandons the queue.
 */

// Shared harness state the mocked rpc reads/writes (hoisted for the vi.mock factory).
const h = vi.hoisted(() => ({
  streamCb: null as null | ((event: unknown) => void),
  agentRunCalls: [] as Array<{
    sessionId: string
    chatId: string
    text: string
    images: unknown
    options: unknown
  }>,
  resumeCalls: [] as Array<{ sessionId: string; planId: string; revision: number | undefined }>,
  diffValue: "diff-0",
  diffCalls: 0,
  filesValue: [] as ReadonlyArray<string>,
  filesCalls: 0,
  statusWrites: [] as Array<string>,
  skillsListCalls: 0,
  stopCalls: [] as Array<string>,
  stopGate: Promise.resolve() as Promise<void>,
  steerCalls: [] as Array<{ sessionId: string; chatId: string; text: string }>,
  steerStatus: "unsupported" as "accepted" | "deferred" | "unsupported",
  // Held to make a steer's reply land AFTER the turn it was aimed at ended.
  steerGate: Promise.resolve() as Promise<void>,
  // Drives the "a stop that rejects must still let the session move on" case.
  stopFails: false,
  /** Push reviewer events into the machine, as ReviewService's stream would. */
  reviewCb: null as null | ((event: unknown) => void),
  // Lets a test hold the catalogue in flight to prove nothing waits on it.
  catalogGate: Promise.resolve() as Promise<void>,
  // Same, for the skills probe — it spawns the harness, so nothing may wait on it.
  skillsGate: Promise.resolve() as Promise<void>,
  approvalRefused: false,
  // Lets a test hold the transcript load, to drive the "typed before it lands" race.
  transcriptGate: Promise.resolve() as Promise<void>,
  transcript: [] as ReadonlyArray<Message>,
  transcriptPageCalls: [] as Array<{ before: string | undefined; limit: number }>,
  currentPlan: null as PlanDocument | null,
  setHarnessCalls: [] as Array<{ sessionId: string; cli: string; model: string }>,
  planCommentCalls: [] as Array<{ planId: string; stepId: string; body: string }>,
  planReviseCalls: [] as Array<string>,
  reasoningCalls: [] as Array<unknown>,
  catalog: [
    { cli: "claude", label: "Claude Code", models: [{ id: "opus", label: "opus" }] },
    { cli: "codex", label: "Codex CLI", models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }] }
  ]
}))

vi.mock("./rpc-client.js", () => ({
  rpc: {
    sessionsTranscriptPage: async (
      _sessionId: string,
      _chatId: string,
      before: string | undefined,
      limit: number
    ) => {
      await h.transcriptGate
      h.transcriptPageCalls.push({ before, limit })
      // Mirror the real store's opaque positional cursor.
      const all = h.transcript
      const match = before === undefined ? null : /^v1:(\d+)$/.exec(before)
      if (before !== undefined && match === null) {
        return { messages: [], hasMore: false }
      }
      const end = match === null ? all.length : Number(match[1])
      const start = Math.max(0, end - limit)
      return {
        messages: all.slice(start, end),
        hasMore: start > 0,
        ...(start > 0 ? { cursor: `v1:${start}` } : {})
      }
    },
    planCurrent: async () => h.currentPlan,
    skillsList: async () => {
      h.skillsListCalls += 1
      await h.skillsGate
      return [{ name: "/deploy", description: "Ship it", source: "skill" }]
    },
    workspaceFiles: async () => {
      h.filesCalls += 1
      return h.filesValue
    },
    modelsCatalog: async () => {
      await h.catalogGate
      return h.catalog
    },
    sessionsDiff: async () => {
      h.diffCalls += 1
      return h.diffValue
    },
    agentRun: (
      sessionId: string,
      chatId: string,
      text: string,
      onEvent: (event: unknown) => void,
      images: unknown,
      options: unknown
    ) => {
      h.agentRunCalls.push({ sessionId, chatId, text, images, options })
      h.streamCb = onEvent
      return () => {
        h.streamCb = null
      }
    },
    agentResumePlan: (
      sessionId: string,
      _chatId: string,
      planId: string,
      revision: number | undefined,
      onEvent: (event: unknown) => void
    ) => {
      h.resumeCalls.push({ sessionId, planId, revision })
      h.streamCb = onEvent
      return () => {
        h.streamCb = null
      }
    },
    reviewWatch: (_sessionId: string, _chatId: string, onEvent: (event: unknown) => void) => {
      h.reviewCb = onEvent
      return () => {
        h.reviewCb = null
      }
    },
    agentDecideGate: async () => {},
    agentAnswerQuestion: async () => {},
    agentSetMode: async () => {},
    agentSetReasoning: async (_sessionId: string, _cli: string, reasoning: unknown) => {
      h.reasoningCalls.push(reasoning)
    },
    agentSetHarness: async (
      sessionId: string,
      _chatId: string,
      cli: string,
      model: string
    ) => {
      h.setHarnessCalls.push({ sessionId, cli, model })
    },
    agentCommentPlanStep: async (
      _sessionId: string,
      planId: string,
      stepId: string,
      body: string
    ) => {
      h.planCommentCalls.push({ planId, stepId, body })
    },
    agentRevisePlan: async (_sessionId: string, planId: string) => {
      h.planReviseCalls.push(planId)
    },
    agentApprovePlan: async () =>
      h.approvalRefused
        ? {
            status: "refused",
            message: "Canonical revision 2 replaced reviewed revision 1.",
            latestRevision: 2
          }
        : { status: "accepted" },
    agentSteer: async (sessionId: string, chatId: string, text: string) => {
      h.steerCalls.push({ sessionId, chatId, text })
      // Lets a test hold the reply so the turn's terminal event overtakes it —
      // the RPC response and the event stream are different paths in the real app.
      await h.steerGate
      return h.steerStatus === "accepted"
        ? {
            status: "accepted" as const,
            user: userMessage("u-steered", text, "2026-07-24T10:00:00.000Z"),
            assistant: assistantMessage("a-steered", "2026-07-24T10:00:00.000Z")
          }
        : { status: h.steerStatus }
    },
    agentStop: async (sessionId: string) => {
      h.stopCalls.push(sessionId)
      await h.stopGate
      if (h.stopFails) throw new Error("stop failed")
    },
    sessionsSetStatus: async (_id: string, status: string) => {
      h.statusWrites.push(status)
    }
  }
}))

const session = {
  id: "s1",
  cli: "claude",
  worktreePath: "/tmp/wt",
  mode: "accept-edits",
  model: null,
  status: "idle",
  activeChatId: "s1",
  chats: [{
    id: "s1",
    title: "Chat 1",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    mode: "accept-edits",
    model: null
  }]
} as unknown as Session

const emit = (event: StreamEvent) => h.streamCb?.(event)
const start = () => createActor(conversationMachine, { input: { session } }).start()
/**
 * The id of the nth queued message, read off the live snapshot — exactly what the
 * view does. Queue actions address a message by id, never by position: the queue
 * removes its own head mid-run, so a position captured at render time can point at
 * a different message by the time the operator clicks.
 */
const queuedId = (actor: ReturnType<typeof start>, n: number): string =>
  actor.getSnapshot().context.queued[n]?.id ?? `missing-${n}`
const idle = "awaitingInput" as const
const githubIdentity = {
  source: "github-feedback" as const,
  deliveryId: "delivery-1",
  semanticKey: "semantic-1"
}

beforeEach(() => {
  h.streamCb = null
  h.approvalRefused = false
  h.agentRunCalls.length = 0
  h.diffValue = "diff-0"
  h.diffCalls = 0
  h.filesValue = []
  h.filesCalls = 0
  h.statusWrites.length = 0
  h.skillsListCalls = 0
  h.stopCalls.length = 0
  h.stopGate = Promise.resolve()
  h.steerCalls.length = 0
  h.steerStatus = "unsupported"
  h.steerGate = Promise.resolve()
  h.stopFails = false
  h.setHarnessCalls.length = 0
  h.catalogGate = Promise.resolve()
  h.skillsGate = Promise.resolve()
  h.transcriptGate = Promise.resolve()
  h.transcript = []
  h.transcriptPageCalls.length = 0
  h.currentPlan = null
  h.planCommentCalls.length = 0
  h.planReviseCalls.length = 0
  h.reviewCb = null
  h.reasoningCalls.length = 0
  h.resumeCalls.length = 0
})

describe("conversationMachine — context size", () => {
  it("rehydrates the persisted context reading before the next live event", async () => {
    const persisted = { ...session, contextTokens: 206_865 } as Session
    const actor = createActor(conversationMachine, { input: { session: persisted } }).start()
    await waitFor(actor, (s) => s.matches(idle))

    expect(actor.getSnapshot().context.tokens).toBe(206_865)
    actor.stop()
  })

  it("keeps the last context reading visible while the next turn starts", async () => {
    const persisted = { ...session, contextTokens: 206_865 } as Session
    const actor = createActor(conversationMachine, { input: { session: persisted } }).start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "continue" })
    await waitFor(actor, (s) => s.matches("running"))

    expect(actor.getSnapshot().context.tokens).toBe(206_865)
    actor.stop()
  })

  it("tracks the latest context and does not replace it with the final run total", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "inspect the repo" })
    await waitFor(actor, (s) => s.matches("running"))

    emit({ _tag: "Usage", tokens: 120_000 })
    expect(actor.getSnapshot().context.tokens).toBe(120_000)

    // Compaction genuinely shrinks the context. A high-water mark would keep
    // lying that the old, larger context was still loaded.
    emit({ _tag: "Usage", tokens: 45_000 })
    expect(actor.getSnapshot().context.tokens).toBe(45_000)

    // Done can carry a terminal context reading for adapters without a live
    // event. It must not overwrite the newer live reading we already received.
    emit({ _tag: "Done", costUsd: 0, tokens: 300_000 })
    await waitFor(actor, (s) => s.matches(idle))
    expect(actor.getSnapshot().context.tokens).toBe(45_000)
    actor.stop()
  })

  it("uses Done as a fallback when a harness has no live context event", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "inspect the repo" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "Done", costUsd: 0, tokens: 42_000 })
    await waitFor(actor, (s) => s.matches(idle))

    expect(actor.getSnapshot().context.tokens).toBe(42_000)
    actor.stop()
  })
})

describe("conversationMachine — lazy history", () => {
  // HISTORY_PAGE_SIZE is 200; the mocked page RPC windows `h.transcript` the same
  // way the real store does, so these drive the whole open → page-back flow.
  const makeTurns = (n: number) =>
    Array.from({ length: n }, (_, i) => userMessage(`u${i}`, `turn ${i}`, "2026-07-11T10:00:00.000Z"))

  it("opens with only the newest window and flags older history", async () => {
    h.transcript = makeTurns(500)
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    const ctx = actor.getSnapshot().context
    expect(ctx.messages).toHaveLength(200)
    expect(ctx.messages[0]!.id).toBe("u300")
    expect(ctx.hasMoreHistory).toBe(true)
    actor.stop()
  })

  it("prepends an older page on LOAD_OLDER using the opaque store cursor", async () => {
    h.transcript = makeTurns(500)
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "LOAD_OLDER" })
    await waitFor(actor, (s) => s.context.messages.length > 200)

    const ctx = actor.getSnapshot().context
    expect(ctx.messages).toHaveLength(400)
    expect(ctx.messages[0]!.id).toBe("u100")
    expect(ctx.hasMoreHistory).toBe(true)
    expect(h.transcriptPageCalls.at(-1)).toStrictEqual({
      before: "v1:300",
      limit: 200
    })
    actor.stop()
  })

  it("clears hasMoreHistory once the start is reached", async () => {
    h.transcript = makeTurns(300)
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "LOAD_OLDER" })
    await waitFor(actor, (s) => s.context.messages.length === 300)
    expect(actor.getSnapshot().context.hasMoreHistory).toBe(false)
    actor.stop()
  })

  it("blocks a second page while one is already in flight", async () => {
    h.transcript = makeTurns(500)
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    const before = h.transcriptPageCalls.length

    // Two clicks in one tick — `canLoadOlder` blocks the second (loadingHistory).
    actor.send({ type: "LOAD_OLDER" })
    actor.send({ type: "LOAD_OLDER" })
    await waitFor(actor, (s) => s.context.messages.length > 200)

    expect(h.transcriptPageCalls.length - before).toBe(1)
    actor.stop()
  })
})

describe("conversationMachine — queue while busy", () => {
  it("coalesces a busy GitHub replay and resolves both waiters after one durable acceptance", async () => {
    h.steerStatus = "accepted"
    const firstAccepted = vi.fn()
    const replayAccepted = vi.fn()
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "current turn" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({
      type: "SEND",
      text: "review feedback",
      externalInstruction: githubIdentity,
      onExternalAccepted: firstAccepted
    })
    actor.send({
      type: "SEND",
      text: "same edited feedback",
      externalInstruction: { ...githubIdentity, deliveryId: "delivery-2" },
      onExternalAccepted: replayAccepted
    })
    expect(actor.getSnapshot().context.queued).toHaveLength(1)
    expect(firstAccepted).not.toHaveBeenCalled()
    expect(replayAccepted).not.toHaveBeenCalled()

    // Neither the automatic ToolEnd flush nor the operator's native Send-now
    // path may consume external feedback. Both would bypass transcript identity
    // acceptance and let a crash replay create a second turn.
    emit({ _tag: "ToolEnd", id: "t-external", status: "success", meta: null, diff: null, preview: null })
    actor.send({ type: "SEND_NOW", id: queuedId(actor, 0) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.steerCalls).toEqual([])
    expect(actor.getSnapshot().context.queued).toHaveLength(1)
    expect(firstAccepted).not.toHaveBeenCalled()
    expect(replayAccepted).not.toHaveBeenCalled()

    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, () => h.agentRunCalls.length === 2)
    const feedbackRuns = h.agentRunCalls.filter((call) => call.text.includes("feedback"))
    expect(feedbackRuns).toHaveLength(1)
    expect(feedbackRuns[0]?.options).toMatchObject({ externalInstruction: githubIdentity })
    expect(h.steerCalls).toEqual([])
    expect(firstAccepted).not.toHaveBeenCalled()
    expect(replayAccepted).not.toHaveBeenCalled()
    emit({
      _tag: "ExternalInstructionAccepted",
      identity: githubIdentity,
      duplicate: false
    })
    expect(firstAccepted).toHaveBeenCalledOnce()
    expect(replayAccepted).toHaveBeenCalledOnce()
    actor.stop()
  })

  it("replays a durably accepted external item after a busy restart without steering or duplicating", async () => {
    h.transcript = [
      userMessage("u-existing", "review feedback", "2026-08-05T09:00:00.000Z", [], githubIdentity),
      { ...assistantMessage("a-existing", "2026-08-05T09:00:00.000Z"), streaming: false }
    ]
    h.steerStatus = "accepted"
    const accepted = vi.fn()
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "current turn after restart" })
    await waitFor(actor, (s) => s.matches("running"))
    actor.send({
      type: "SEND",
      text: "review feedback",
      externalInstruction: { ...githubIdentity, deliveryId: "delivery-replayed" },
      onExternalAccepted: accepted
    })
    emit({ _tag: "ToolEnd", id: "t-replay", status: "success", meta: null, diff: null, preview: null })
    expect(h.steerCalls).toEqual([])
    expect(actor.getSnapshot().context.queued).toHaveLength(1)

    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, () => h.agentRunCalls.length === 2)
    expect(h.agentRunCalls.filter((call) => call.text === "review feedback")).toHaveLength(1)
    expect(accepted).not.toHaveBeenCalled()
    emit({
      _tag: "ExternalInstructionAccepted",
      identity: githubIdentity,
      duplicate: true
    })
    await waitFor(actor, (s) => s.matches(idle))

    expect(accepted).toHaveBeenCalledOnce()
    expect(h.steerCalls).toEqual([])
    expect(
      actor.getSnapshot().context.messages.filter(
        (message) => message.externalInstruction?.semanticKey === githubIdentity.semanticKey
      )
    ).toHaveLength(1)
    actor.stop()
  })

  it("removes an optimistic replay after main reports a fresh-app durable duplicate", async () => {
    h.transcript = [
      userMessage("u-existing", "review feedback", "2026-08-05T09:00:00.000Z", [], githubIdentity),
      { ...assistantMessage("a-existing", "2026-08-05T09:00:00.000Z"), streaming: false }
    ]
    const accepted = vi.fn()
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({
      type: "SEND",
      text: "review feedback",
      externalInstruction: githubIdentity,
      onExternalAccepted: accepted
    })
    await waitFor(actor, (s) => s.matches("running"))
    expect(actor.getSnapshot().context.messages).toHaveLength(4)

    emit({
      _tag: "ExternalInstructionAccepted",
      identity: githubIdentity,
      duplicate: true
    })
    await waitFor(actor, (s) => s.matches(idle))
    expect(accepted).toHaveBeenCalledOnce()
    expect(actor.getSnapshot().context.messages).toHaveLength(2)
    expect(actor.getSnapshot().context.messages.filter((message) => message.role === "user"))
      .toHaveLength(1)
    actor.stop()
  })

  it("queues a message sent mid-run and replays it once the run completes", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))
    expect(h.agentRunCalls).toHaveLength(1)
    expect(h.agentRunCalls[0]!.text).toBe("first")

    // Sent while the agent is busy → queued, not dispatched.
    actor.send({ type: "SEND", text: "second" })
    // `toMatchObject`, because each queued message also carries the stable id its
    // row actions address it by (see `queuedId`).
    expect(actor.getSnapshot().context.queued).toMatchObject([
      { text: "second", images: [] }
    ])
    expect(h.agentRunCalls).toHaveLength(1)

    // Finishing the turn drains the queue: refresh diff, then start the queued turn.
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, () => h.agentRunCalls.length === 2, { timeout: 3000 })
    expect(h.agentRunCalls[1]!.text).toBe("second")
    expect(actor.getSnapshot().context.queued).toEqual([])
    actor.stop()
  })


  it("UNQUEUE drops a still-pending queued message", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "a" })
    actor.send({ type: "SEND", text: "b" })
    expect(actor.getSnapshot().context.queued.map((q) => q.text)).toEqual(["a", "b"])

    actor.send({ type: "UNQUEUE", id: queuedId(actor, 0) })
    expect(actor.getSnapshot().context.queued.map((q) => q.text)).toEqual(["b"])
    actor.stop()
  })

  it("SEND_NOW interrupts the current turn and runs the picked message next (jumping the queue)", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))
    expect(h.agentRunCalls).toHaveLength(1)

    // Queue two; steer to the second one ("b") mid-run.
    actor.send({ type: "SEND", text: "a" })
    actor.send({ type: "SEND", text: "b" })
    actor.send({ type: "SEND_NOW", id: queuedId(actor, 1) })

    // The current turn is interrupted and "b" runs next, ahead of "a".
    await waitFor(actor, () => h.agentRunCalls.length === 2, { timeout: 3000 })
    expect(h.agentRunCalls[1]!.text).toBe("b")
    expect(h.steerCalls).toEqual([{ sessionId: "s1", chatId: "s1", text: "b" }])
    expect(actor.getSnapshot().context.queued.map((q) => q.text)).toEqual(["a"])
    actor.stop()
  })

  it("SEND_NOW steers a live Codex turn without stopping or replaying it", async () => {
    h.steerStatus = "accepted"
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "steer this" })
    actor.send({ type: "SEND_NOW", id: queuedId(actor, 0) })

    await waitFor(actor, (s) => s.context.messages.at(-1)?.id === "a-steered")
    expect(h.stopCalls).toEqual([])
    expect(h.agentRunCalls).toHaveLength(1)
    expect(actor.getSnapshot().context.queued).toEqual([])
    expect(actor.getSnapshot().context.messages.slice(-2).map((message) => message.id)).toEqual([
      "u-steered",
      "a-steered"
    ])
    actor.stop()
  })

  it("SEND_NOW keeps input queued while Codex is compacting", async () => {
    h.steerStatus = "deferred"
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "after compaction" })
    actor.send({ type: "SEND_NOW", id: queuedId(actor, 0) })
    await waitFor(actor, () => h.steerCalls.length === 1)

    expect(h.stopCalls).toEqual([])
    expect(actor.getSnapshot().context.queued.map((queued) => queued.text)).toEqual([
      "after compaction"
    ])
    actor.stop()
  })

  it("EDIT_QUEUED rewrites a queued message in place, keeping its position", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "a" })
    actor.send({ type: "SEND", text: "b" })
    actor.send({ type: "EDIT_QUEUED", id: queuedId(actor, 0), text: "a, but properly" })

    // Position is load-bearing: every row is addressed by index, so an edit that
    // reordered the queue would make the NEXT click hit a different message.
    expect(actor.getSnapshot().context.queued.map((q) => q.text)).toEqual(["a, but properly", "b"])
    actor.stop()
  })

  it("EDIT_QUEUED to nothing drops the message rather than queueing a blank turn", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "never mind" })
    actor.send({ type: "EDIT_QUEUED", id: queuedId(actor, 0), text: "   " })
    expect(actor.getSnapshot().context.queued).toEqual([])
    actor.stop()
  })

  /**
   * The queue's automatic flush. Holding a message until the whole turn settled
   * meant a correction typed 10 seconds in was answered minutes later, against
   * the work it was meant to redirect — so the head goes to the live turn at the
   * first tool boundary, Claude-Code style.
   */
  it("hands the head of the queue to the live turn at the next tool boundary", async () => {
    h.steerStatus = "accepted"
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "also update the README" })
    // Nothing has happened yet — a queued message must not interrupt mid-tool.
    expect(h.steerCalls).toEqual([])

    emit({ _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: null, preview: null })
    await waitFor(actor, () => h.steerCalls.length === 1, { timeout: 3000 })

    expect(h.steerCalls[0]).toMatchObject({ text: "also update the README" })
    await waitFor(actor, (s) => s.context.queued.length === 0, { timeout: 3000 })
    // Steered INTO the turn: no stop, no replay as a second run.
    expect(h.stopCalls).toEqual([])
    expect(h.agentRunCalls).toHaveLength(1)
    actor.stop()
  })

  it("flushes one message per boundary, never a burst", async () => {
    h.steerStatus = "accepted"
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "one" })
    actor.send({ type: "SEND", text: "two" })
    emit({ _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: null, preview: null })
    await waitFor(actor, (s) => s.context.queued.length === 1, { timeout: 3000 })
    expect(actor.getSnapshot().context.queued.map((q) => q.text)).toEqual(["two"])

    emit({ _tag: "ToolEnd", id: "t2", status: "success", meta: null, diff: null, preview: null })
    await waitFor(actor, () => h.steerCalls.length === 2, { timeout: 3000 })
    expect(h.steerCalls.map((c) => c.text)).toEqual(["one", "two"])
    actor.stop()
  })

  it("an automatic flush the harness cannot take NEVER stops the turn", async () => {
    // The operator asked for nothing here, so the stop-and-replay fallback that
    // "Send now" uses would be an unprompted interruption at every tool call.
    h.steerStatus = "unsupported"
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "later is fine" })
    emit({ _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: null, preview: null })
    await waitFor(actor, () => h.steerCalls.length === 1, { timeout: 3000 })

    expect(h.stopCalls).toEqual([])
    expect(actor.getSnapshot().value).toBe("running")
    // Still queued, so it runs as the next turn exactly as before.
    expect(actor.getSnapshot().context.queued.map((q) => q.text)).toEqual(["later is fine"])
    actor.stop()
  })

  /**
   * The steer's reply and the turn's `Done` travel different paths (an RPC
   * response vs the event stream), so the reply can land after the turn ended.
   * Handled only in `running`, it was silently dropped — and a dropped `accepted`
   * left the message in the queue, so the next dequeue REPLAYED a message the
   * agent had already answered.
   */
  it("does not replay a message the agent accepted, when the reply lands after the turn", async () => {
    h.steerStatus = "accepted"
    let release = () => {}
    h.steerGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "also update the README" })
    emit({ _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: null, preview: null })
    await waitFor(actor, () => h.steerCalls.length === 1, { timeout: 3000 })

    // The turn ends while the steer's reply is still in flight.
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    release()

    await waitFor(actor, (s) => s.context.queued.length === 0, { timeout: 3000 })
    await waitFor(actor, (s) => s.matches(idle), { timeout: 3000 })
    // One run, not two: the accepted message was delivered inside the first turn.
    expect(h.agentRunCalls).toHaveLength(1)
    actor.stop()
  })

  it("does not latch the steer guard when the reply lands after the turn", async () => {
    // A latched `steeringId` disables BOTH the automatic flush and "Send now"
    // for the rest of this chat's life — silently, with no error anywhere.
    h.steerStatus = "deferred"
    let release = () => {}
    h.steerGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "later is fine" })
    emit({ _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: null, preview: null })
    await waitFor(actor, () => h.steerCalls.length === 1, { timeout: 3000 })
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    release()

    // The queued message runs as the next turn; its own boundary must flush again.
    await waitFor(actor, () => h.agentRunCalls.length === 2, { timeout: 3000 })
    expect(actor.getSnapshot().context.steeringId).toBeNull()

    actor.send({ type: "SEND", text: "and one more" })
    emit({ _tag: "ToolEnd", id: "t2", status: "success", meta: null, diff: null, preview: null })
    await waitFor(actor, () => h.steerCalls.length === 2, { timeout: 3000 })
    actor.stop()
  })

  it("does not run a message twice when it is edited while its steer is in flight", async () => {
    // The queue used to be filtered by object identity, and an edit replaces the
    // object — so the edited copy survived the filter and ran again after the
    // agent had already been given it.
    h.steerStatus = "accepted"
    let release = () => {}
    h.steerGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "SEND", text: "also update the README" })
    const id = queuedId(actor, 0)
    emit({ _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: null, preview: null })
    await waitFor(actor, () => h.steerCalls.length === 1, { timeout: 3000 })

    // Edited after the steer left, before its reply came back.
    actor.send({ type: "EDIT_QUEUED", id, text: "also update the CHANGELOG" })
    expect(actor.getSnapshot().context.queued.map((q) => q.id)).toEqual([id])
    release()

    await waitFor(actor, (s) => s.context.queued.length === 0, { timeout: 3000 })
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, (s) => s.matches(idle), { timeout: 3000 })
    expect(h.agentRunCalls).toHaveLength(1)
    actor.stop()
  })

  it("STOP abandons any queued messages", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "first" })
    await waitFor(actor, (s) => s.matches("running"))
    actor.send({ type: "SEND", text: "queued" })
    expect(actor.getSnapshot().context.queued).toHaveLength(1)

    actor.send({ type: "STOP" })
    await waitFor(actor, (s) => s.matches(idle), { timeout: 3000 })
    expect(actor.getSnapshot().context.queued).toEqual([])
    actor.stop()
  })
})

/**
 * What the renderer must do while sub-agents are still working.
 *
 * The adapter now withholds a turn's `Done` until its last sub-agent bookends
 * (`turn-continuation.ts`), because every sub-agent runs inside the ONE SDK query
 * that `Done` used to close — so settling early aborted all of them. That changes
 * which events the machine sees while `running`, and these cases pin the three
 * consequences rather than leaving them to be discovered by a user.
 */
describe("conversationMachine — talking to the main agent while sub-agents run", () => {
  it("stays in running with its tabs live while no Done arrives", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "fan out" })
    await waitFor(actor, (s) => s.matches("running"))

    emit({ _tag: "SubagentStarted", id: "task_1", name: "Explore", description: "map it", parentId: null })
    emit({ _tag: "Assistant", text: "reading", agentId: "task_1" })

    // No terminal event: the machine must not go looking for one. Leaving `running`
    // here is what closed the RPC stream's scope and got the run reaped.
    expect(actor.getSnapshot().matches("running")).toBe(true)
    expect(actor.getSnapshot().context.subagents).toHaveLength(1)

    emit({ _tag: "SubagentEnded", id: "task_1", status: "done" })
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, (s) => s.matches(idle))
    actor.stop()
  })

  it("flushes a queued message on a sub-agent's tool boundary — steering, not stopping", async () => {
    // The reported scenario. `canAutoFlush` fires on any `ToolEnd`, and a sub-agent's
    // carries an `agentId` — deliberately still eligible, because the push goes into
    // the same live query and is what lets the operator talk mid-flight. The
    // alternative path (`unsupported` → `stopping` → `agentStop`) is the one that
    // aborts every sub-agent, so the assertion is that we never take it.
    h.steerStatus = "accepted"
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "fan out" })
    await waitFor(actor, (s) => s.matches("running"))

    emit({ _tag: "SubagentStarted", id: "task_1", name: "Explore", description: "map it", parentId: null })
    actor.send({ type: "SEND", text: "also check the tests" })
    expect(h.steerCalls).toHaveLength(0)

    emit({ _tag: "ToolEnd", id: "r1", status: "success", meta: null, diff: null, preview: null, agentId: "task_1" })

    // Wait for the steer's REPLY, not just the call: the reply is what could still
    // escalate to `stopping`, so asserting before it lands would prove nothing.
    await waitFor(actor, (s) => h.steerCalls.length === 1 && s.context.steeringId === null, {
      timeout: 3000
    })
    expect(h.steerCalls[0]).toMatchObject({ text: "also check the tests" })
    // Never stopped, and never replayed as a fresh run — the sub-agents survive.
    expect(actor.getSnapshot().matches("running")).toBe(true)
    expect(h.stopCalls).toEqual([])
    expect(h.agentRunCalls).toHaveLength(1)
    actor.stop()
  })

  it("does not escalate an auto-flush the harness could not take", async () => {
    // An `unsupported` reply to the queue's OWN flush must leave the message queued.
    // Escalating it to `stopping` would abort the query — killing the sub-agents to
    // deliver a message that could simply have waited for the next tool boundary.
    h.steerStatus = "unsupported"
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "fan out" })
    await waitFor(actor, (s) => s.matches("running"))

    emit({ _tag: "SubagentStarted", id: "task_1", name: "Explore", description: "map it", parentId: null })
    actor.send({ type: "SEND", text: "later" })
    emit({ _tag: "ToolEnd", id: "r1", status: "success", meta: null, diff: null, preview: null, agentId: "task_1" })

    await waitFor(actor, (s) => h.steerCalls.length === 1 && s.context.steeringId === null, {
      timeout: 3000
    })
    expect(actor.getSnapshot().matches("running")).toBe(true)
    expect(h.stopCalls).toEqual([])
    expect(actor.getSnapshot().context.queued.map((q) => q.text)).toEqual(["later"])
    actor.stop()
  })

  it("STOP is still global — it clears every sub-agent tab", async () => {
    // The operator's own halt is one button for one turn, and a held-open turn is
    // still one turn. No completion events will arrive for the tabs, so they go too.
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "fan out" })
    await waitFor(actor, (s) => s.matches("running"))

    emit({ _tag: "SubagentStarted", id: "task_1", name: "Explore", description: "a", parentId: null })
    emit({ _tag: "SubagentStarted", id: "task_2", name: "Explore", description: "b", parentId: null })
    expect(actor.getSnapshot().context.subagents).toHaveLength(2)

    actor.send({ type: "STOP" })
    expect(actor.getSnapshot().context.subagents).toEqual([])
    expect(h.stopCalls).toEqual(["s1"])
    actor.stop()
  })
})

describe("conversationMachine — nothing gates the transcript on a CLI probe", () => {
  /**
   * `loading` handles almost no events, so anything it waits on becomes a window
   * where the operator's input is silently swallowed. `Skills.list` asks the
   * HARNESS what commands it has — it spawns the binary, taking up to seconds —
   * so awaiting it in `loadConversation` meant a prompt typed on open did
   * nothing at all: the composer looked alive, the send vanished.
   *
   * Holding the skills fetch in flight here proves the machine reaches
   * `awaitingInput` regardless, mirroring the same guarantee the catalogue has.
   */
  /**
   * The composer is enabled from the first paint, so a prompt can be sent before
   * the transcript lands. A dropped one is invisible — the box clears and the
   * operator believes they sent it — so it's held and run the moment the load
   * settles, exactly as a send during a run is.
   */
  it("holds a prompt sent before the transcript lands, then runs it", async () => {
    let release = () => {}
    h.transcriptGate = new Promise<void>((r) => (release = r))

    const actor = start()
    expect(actor.getSnapshot().matches("loading")).toBe(true)

    actor.send({ type: "SEND", text: "typed on open" })
    // Held, not dispatched — there's no transcript to append it to yet.
    expect(h.agentRunCalls).toHaveLength(0)
    expect(actor.getSnapshot().context.queued).toMatchObject([
      { text: "typed on open", images: [] }
    ])

    release()
    await waitFor(actor, (s) => s.matches("running"), { timeout: 3000 })
    expect(h.agentRunCalls).toHaveLength(1)
    expect(h.agentRunCalls[0]!.text).toBe("typed on open")
    expect(actor.getSnapshot().context.queued).toEqual([])
    actor.stop()
  })

  /** Losing the transcript is no reason to also lose what the operator typed. */
  it("still runs a held prompt when the load FAILS", async () => {
    h.transcriptGate = Promise.reject(new Error("disk gone"))

    const actor = start()
    actor.send({ type: "SEND", text: "typed on open" })

    await waitFor(actor, (s) => s.matches("running"), { timeout: 3000 })
    expect(h.agentRunCalls[0]!.text).toBe("typed on open")
    actor.stop()
  })

  it("reaches idle and accepts a send while the skills probe is still in flight", async () => {
    let release = () => {}
    h.skillsGate = new Promise<void>((r) => (release = r))

    const actor = start()
    await waitFor(actor, (s) => s.matches(idle), { timeout: 3000 })

    actor.send({ type: "SEND", text: "hello" })
    await waitFor(actor, (s) => s.matches("running"), { timeout: 3000 })
    expect(h.agentRunCalls).toHaveLength(1)

    // The `/` menu fills itself in a beat later, without having blocked anything.
    release()
    await waitFor(actor, (s) => s.context.skills.length > 0, { timeout: 3000 })
    actor.stop()
  })
})

describe("conversationMachine — realtime Changes rail", () => {
  it("re-reads the diff mid-run when an edit tool lands", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "edit a file" })
    await waitFor(actor, (s) => s.matches("running"))

    const before = h.diffCalls
    h.diffValue = "diff-after-edit"
    emit({ _tag: "ToolStart", id: "e1", name: "Write", target: "a.ts" })
    emit({ _tag: "ToolEnd", id: "e1", status: "success", meta: null, diff: { added: 3, removed: 0 }, preview: null })

    await waitFor(actor, (s) => s.context.patch === "diff-after-edit", { timeout: 3000 })
    expect(h.diffCalls).toBeGreaterThan(before)
    // The turn is still live — the live refresh doesn't end it.
    expect(actor.getSnapshot().matches("running")).toBe(true)
    actor.stop()
  })

  it("does not refresh the diff for a read-only tool (no file change)", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "read a file" })
    await waitFor(actor, (s) => s.matches("running"))

    const before = h.diffCalls
    emit({ _tag: "ToolStart", id: "r1", name: "Read", target: "a.ts" })
    emit({ _tag: "ToolEnd", id: "r1", status: "success", meta: "10 lines", diff: null, preview: null })

    // A Read reports no diff → no live refresh fires.
    expect(h.diffCalls).toBe(before)
    actor.stop()
  })

  it("refreshes openable files after a Codex edit with no diff", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "create a report" })
    await waitFor(actor, (s) => s.matches("running"))

    const before = h.filesCalls
    h.filesValue = ["reports/codex-created.md"]
    emit({
      _tag: "ToolStart",
      id: "codex-edit-1",
      name: "Edit",
      target: "/worktree/reports/codex-created.md"
    })
    emit({
      _tag: "ToolEnd",
      id: "codex-edit-1",
      status: "success",
      meta: null,
      diff: null,
      preview: null
    })

    await waitFor(
      actor,
      (s) => s.context.files.includes("reports/codex-created.md"),
      { timeout: 3000 }
    )
    expect(h.filesCalls).toBeGreaterThan(before)
    expect(actor.getSnapshot().matches("running")).toBe(true)
    actor.stop()
  })
})

describe("conversationMachine — image attachments", () => {
  it("passes attached images to the agent and records them on the user turn", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    const image = { id: "i1", name: "x.png", mediaType: "image/png", data: "aGk=" }

    actor.send({ type: "SEND", text: "see this", images: [image] })
    await waitFor(actor, (s) => s.matches("running"))

    expect(h.agentRunCalls[0]!.images).toEqual([image])
    const user = actor.getSnapshot().context.messages.find((m) => m.role === "user")!
    expect(user.parts.some((p) => p._tag === "Image" && p.attachment.id === "i1")).toBe(true)
    actor.stop()
  })

  it("loads the model catalogue into context", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.context.catalog.length > 0)
    expect(actor.getSnapshot().context.catalog).toStrictEqual(h.catalog)
    expect(actor.getSnapshot().context.cli).toBe("claude")
    actor.stop()
  })

  /**
   * REGRESSION: the catalogue must NOT be part of `loadConversation`.
   *
   * `loading` has no event handlers, so anything the operator does before the
   * load settles is dropped on the floor. Fetching the catalogue inline reaches
   * DiscoveryService + probes the Codex CLI for models — seconds — which widened
   * that window enough that an immediate Shift+Tab or send was silently ignored
   * (it broke four e2e tests). The transcript must not wait on the model chip.
   */
  it("reaches idle without waiting for the model catalogue", async () => {
    let releaseCatalog = () => {}
    h.catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve
    })

    const actor = start()
    // Idle while the catalogue is still in flight — so events aren't dropped.
    await waitFor(actor, (s) => s.matches(idle))
    expect(actor.getSnapshot().context.catalog).toStrictEqual([])

    // The operator can act immediately, and it takes effect.
    actor.send({ type: "SET_MODE", mode: "auto" })
    expect(actor.getSnapshot().context.mode).toBe("auto")

    releaseCatalog()
    await waitFor(actor, (s) => s.context.catalog.length > 0)
    actor.stop()
  })

  describe("SET_HARNESS", () => {
    it("changes only the model when staying on the same harness", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))
      // Skills land OUT OF BAND now (the fetch probes the harness, so gating the
      // transcript on it would freeze the composer) — wait for the first one
      // before asserting that a same-harness switch doesn't trigger a second.
      await waitFor(actor, (s) => s.context.skills.length > 0)
      const skillsBefore = h.skillsListCalls

      actor.send({ type: "SET_HARNESS", cli: "claude", model: "haiku" })

      const { context } = actor.getSnapshot()
      expect(context.model).toBe("haiku")
      expect(context.cli).toBe("claude")
      expect(context.session.chats[0]?.model).toBe("haiku")
      expect(h.setHarnessCalls).toStrictEqual([{ sessionId: "s1", cli: "claude", model: "haiku" }])
      // Same harness → same skills; refetching would be pointless work.
      expect(h.skillsListCalls).toBe(skillsBefore)
      expect(context.skills.length).toBeGreaterThan(0)
      actor.stop()
    })

    /**
     * The composer's chips are live while the conversation loads, and loading is
     * NOT instant — it asks the harness for its command list, which means
     * spawning it. A switch made in that window used to be swallowed: the menu
     * closed, the chip snapped back, nothing happened.
     *
     * Every other test here waits for `idle` first, which is exactly why none of
     * them caught it — this one deliberately does not.
     */
    it("honours a switch made while the conversation is still loading", async () => {
      const actor = start()
      expect(actor.getSnapshot().matches("loading")).toBe(true)

      actor.send({ type: "SET_HARNESS", cli: "codex", model: "gpt-5.6-sol" })

      expect(actor.getSnapshot().context.cli).toBe("codex")
      expect(actor.getSnapshot().context.session).toMatchObject({
        cli: "codex",
        model: "gpt-5.6-sol",
        chats: [{ id: "s1", model: "gpt-5.6-sol" }]
      })
      expect(h.setHarnessCalls).toStrictEqual([
        { sessionId: "s1", cli: "codex", model: "gpt-5.6-sol" }
      ])

      // …and the load completing must not clobber the choice: `onDone` assigns
      // transcript state only.
      await waitFor(actor, (s) => s.matches(idle))
      expect(actor.getSnapshot().context.cli).toBe("codex")
      expect(actor.getSnapshot().context.model).toBe("gpt-5.6-sol")
      actor.stop()
    })

    it("honours a mode change made while the conversation is still loading", async () => {
      const actor = start()
      expect(actor.getSnapshot().matches("loading")).toBe(true)

      actor.send({ type: "SET_MODE", mode: "auto" })

      expect(actor.getSnapshot().context.mode).toBe("auto")
      await waitFor(actor, (s) => s.matches(idle))
      expect(actor.getSnapshot().context.mode).toBe("auto")
      actor.stop()
    })

    it("switches harness and refetches the harness-specific skills", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))
      // As above — count from AFTER the out-of-band initial fetch, or the
      // "+1 refetch" assertion below races it.
      await waitFor(actor, (s) => s.context.skills.length > 0)
      const skillsBefore = h.skillsListCalls

      actor.send({ type: "SET_HARNESS", cli: "codex", model: "gpt-5.6-sol" })

      expect(actor.getSnapshot().context.cli).toBe("codex")
      expect(actor.getSnapshot().context.model).toBe("gpt-5.6-sol")
      // The old harness's `/` menu must not linger.
      expect(h.skillsListCalls).toBe(skillsBefore + 1)
      await waitFor(actor, (s) => s.context.skills.length > 0)
      actor.stop()
    })

    // The runner reads `session.cli`; if the mirror lagged, the chip would say
    // "codex" while the next turn still ran on Claude.
    it("mirrors the switch onto the session and drops the stale resume id", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))

      actor.send({ type: "SET_HARNESS", cli: "codex", model: "gpt-5.6-sol" })

      const { session: updated } = actor.getSnapshot().context
      expect(updated.cli).toBe("codex")
      expect(updated.resumeId).toBeUndefined()
      actor.stop()
    })

    it("keeps plan mode when the new harness can plan too", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))
      actor.send({ type: "SET_MODE", mode: "plan" })
      expect(actor.getSnapshot().context.mode).toBe("plan")

      actor.send({ type: "SET_HARNESS", cli: "codex", model: "gpt-5.6-sol" })

      // Codex submits its plan as a fenced block instead of `ExitPlanMode`, so
      // there is nothing to downgrade — dropping the mode would have discarded
      // the operator's in-flight planning session for no reason.
      expect(actor.getSnapshot().context.mode).toBe("plan")
      actor.stop()
    })

    it("degrades plan mode to ask on a harness that cannot plan", async () => {
      const actor = start()
      await waitFor(actor, (s) => s.matches(idle))
      actor.send({ type: "SET_MODE", mode: "plan" })

      actor.send({ type: "SET_HARNESS", cli: "cursor", model: "composer-1" })

      // Cursor falls through to the scripted stub, so its "plan" would be
      // fabricated. Better to say `ask` than to invent one.
      expect(actor.getSnapshot().context.mode).toBe("ask")
      actor.stop()
    })
  })
})

/**
 * The reviewer is surfaced as a tab in the same bar as the harness's
 * sub-agents — but it is NOT part of a turn (the PR button or the background
 * auto-review poll starts it), which is what makes its lifetime different.
 */
describe("conversationMachine — reviewer tab", () => {
  const review = (event: StreamEvent) => h.reviewCb?.(event)

  it("has no reviewer tab until a review runs", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    expect(actor.getSnapshot().context.reviewer).toBeNull()
    expect(actor.getSnapshot().context.reviewStartedAt).toBeNull()
    actor.stop()
  })

  it("opens a working tab and accrues the reviewer's output", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    review({ _tag: "Started", sessionId: "review_s1" })
    review({ _tag: "Assistant", text: "Looks suspicious" })

    const { reviewer } = actor.getSnapshot().context
    expect(reviewer?.status).toBe("working")
    expect(reviewer?.name).toBe("Reviewer")
    expect(reviewer?.message.parts.some((p) => p._tag === "Text" && p.text.includes("suspicious"))).toBe(true)
    actor.stop()
  })

  // The button's whole job: say where the review is, from the reviewer's own events.
  it("tracks the phase through the run", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    review({ _tag: "Started", sessionId: "review_s1" })
    expect(actor.getSnapshot().context.reviewPhase).toBe("starting")

    review({ _tag: "ToolStart", id: "t1", name: "Read", target: "a.ts" })
    expect(actor.getSnapshot().context.reviewPhase).toBe("reading")

    // A gap between tool calls must not strobe the label back to something else.
    review({ _tag: "ToolEnd", id: "t1", status: "success", meta: null, diff: null, preview: null })
    expect(actor.getSnapshot().context.reviewPhase).toBe("reading")

    review({ _tag: "Assistant", text: '{"findings":[]}' })
    expect(actor.getSnapshot().context.reviewPhase).toBe("writing")

    review({ _tag: "Done", costUsd: 0, tokens: 0 })
    expect(actor.getSnapshot().context.reviewPhase).toBe("done")
    // Timer stops → the button drops out of its running state.
    expect(actor.getSnapshot().context.reviewStartedAt).toBeNull()
    expect(actor.getSnapshot().context.reviewer?.status).toBe("done")
    actor.stop()
  })

  it("times the run from Started", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    review({ _tag: "Started", sessionId: "review_s1" })
    expect(actor.getSnapshot().context.reviewStartedAt).not.toBeNull()
    actor.stop()
  })

  it("marks the tab errored when the reviewer fails", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    review({ _tag: "Started", sessionId: "review_s1" })
    review({ _tag: "Failed", message: "boom" })

    expect(actor.getSnapshot().context.reviewer?.status).toBe("error")
    expect(actor.getSnapshot().context.reviewPhase).toBe("error")
    expect(actor.getSnapshot().context.reviewStartedAt).toBeNull()
    actor.stop()
  })

  // Re-reviewing publishes onto the same channel; without a reset the second run's
  // output would append onto the first's transcript.
  it("starts a fresh tab when a second review begins", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    review({ _tag: "Started", sessionId: "review_s1" })
    review({ _tag: "Assistant", text: "first run" })
    review({ _tag: "Done", costUsd: 0, tokens: 0 })

    review({ _tag: "Started", sessionId: "review_s1" })
    const { reviewer } = actor.getSnapshot().context
    expect(reviewer?.status).toBe("working")
    expect(JSON.stringify(reviewer?.message.parts)).not.toContain("first run")
    actor.stop()
  })

  it("keeps a running reviewer when a new turn starts", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    review({ _tag: "Started", sessionId: "review_s1" })
    review({ _tag: "Assistant", text: "still working" })

    // Sending a message clears the turn's sub-agents — but the review isn't part
    // of that turn, and losing sight of a live agent for typing would be wrong.
    actor.send({ type: "SEND", text: "hello" })
    await waitFor(actor, (s) => s.matches("running"))

    expect(actor.getSnapshot().context.subagents).toEqual([])
    expect(actor.getSnapshot().context.reviewer?.status).toBe("working")
    actor.stop()
  })

  it("clears a finished reviewer when a new turn starts", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    review({ _tag: "Started", sessionId: "review_s1" })
    review({ _tag: "Done", costUsd: 0, tokens: 0 })

    actor.send({ type: "SEND", text: "hello" })
    await waitFor(actor, (s) => s.matches("running"))

    // A done tab clears with the sub-agents — same rule as theirs.
    expect(actor.getSnapshot().context.reviewer).toBeNull()
    actor.stop()
  })

  // STOP interrupts the agent turn, not the review — they're separate runs.
  it("does not stop the reviewer when the turn is stopped", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "hello" })
    await waitFor(actor, (s) => s.matches("running"))
    review({ _tag: "Started", sessionId: "review_s1" })

    actor.send({ type: "STOP" })
    await waitFor(actor, (s) => s.matches(idle), { timeout: 3000 })

    expect(actor.getSnapshot().context.reviewer?.status).toBe("working")
    actor.stop()
  })
})

/**
 * The persisted `Session.status` is what the sidebar falls back to for a session
 * the operator hasn't opened this run. It used to be written once at creation and
 * never updated, so every unopened session read "idle" — even one blocked on an
 * approval. These assert it now tracks reality, and — critically — that a BUSY
 * status is never written: a run dies with the app, so persisting "thinking"
 * would strand the session in it forever after a restart.
 */
describe("conversationMachine — persisted status", () => {
  it("does not write on load when the status already matches", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    expect(h.statusWrites).toStrictEqual([])
    actor.stop()
  })

  it("never persists a busy status while the agent runs", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "Assistant", text: "working" })

    expect(h.statusWrites).toStrictEqual([])
    actor.stop()
  })

  it("records needs-input when a turn settles on a pending gate", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({
      _tag: "GateRequested",
      gate: {
        id: "g1",
        kind: "command",
        title: "run a command",
        detail: "Not in your allowlist.",
        command: "npm test",
        allowLabel: "npm test",
        status: "pending"
      }
    })
    emit({ _tag: "Done", costUsd: 0, tokens: 1 })
    await waitFor(actor, (s) => s.matches(idle))

    expect(h.statusWrites).toStrictEqual(["needs-input"])
    actor.stop()
  })

  it("returns to idle once the gate is decided, and never re-writes the same status", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({
      _tag: "GateRequested",
      gate: {
        id: "g1",
        kind: "command",
        title: "run a command",
        detail: "d",
        command: "npm test",
        allowLabel: "npm test",
        status: "pending"
      }
    })
    emit({ _tag: "Done", costUsd: 0, tokens: 1 })
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "DECIDE_GATE", gateId: "g1", decision: "allow" })
    actor.send({ type: "SEND", text: "again" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "Done", costUsd: 0, tokens: 1 })
    await waitFor(actor, (s) => s.matches(idle))

    // needs-input → idle, and no duplicate writes of an unchanged status.
    expect(h.statusWrites).toStrictEqual(["needs-input", "idle"])
    actor.stop()
  })
})

describe("conversationMachine — volatile plan drafts", () => {
  const proposedPlan = {
    id: "plan_live_1",
    summary: "Live plan",
    structured: true,
    graph: null,
    comments: [],
    status: "proposed",
    raw: "<h1>PRD: Live plan</h1>",
    steps: []
  } as unknown as Plan

  it("routes a composer message into the parked plan as revision feedback", async () => {
    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))
    actor.send({ type: "SEND", text: "plan it" })
    await waitFor(actor, (snapshot) => snapshot.matches("running"))
    emit({ _tag: "PlanProposed", plan: proposedPlan })

    actor.send({ type: "SEND", text: "Use durable objects for concurrency." })

    expect(actor.getSnapshot().context.queued).toStrictEqual([])
    expect(actor.getSnapshot().context.sharedPlan).toMatchObject({
      id: proposedPlan.id,
      status: "revising",
      comments: [{ body: "Use durable objects for concurrency.", routed: true }]
    })
    await vi.waitFor(() => {
      expect(h.planCommentCalls).toStrictEqual([{
        planId: proposedPlan.id,
        stepId: "",
        body: "Use durable objects for concurrency."
      }])
      expect(h.planReviseCalls).toStrictEqual([proposedPlan.id])
    })
    expect(h.steerCalls).toStrictEqual([])
    actor.stop()
  })

  it("makes Send now route an already-queued message into the parked plan", async () => {
    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))
    actor.send({ type: "SEND", text: "plan it" })
    await waitFor(actor, (snapshot) => snapshot.matches("running"))

    // The message landed a beat before PlanProposed, so it took the ordinary
    // queue path. Once the plan appears, its existing Send now affordance must
    // still become a revision action rather than a permanently deferred steer.
    actor.send({ type: "SEND", text: "Research the newest MCP transport." })
    const id = queuedId(actor, 0)
    emit({ _tag: "PlanProposed", plan: proposedPlan })
    actor.send({ type: "SEND_NOW", id })

    expect(actor.getSnapshot().context.queued).toStrictEqual([])
    await vi.waitFor(() => {
      expect(h.planReviseCalls).toStrictEqual([proposedPlan.id])
    })
    expect(h.steerCalls).toStrictEqual([])
    actor.stop()
  })

  it("tracks cumulative source without touching the transcript and promotes atomically", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "plan it" })
    await waitFor(actor, (s) => s.matches("running"))

    emit({
      _tag: "PlanDraft",
      draft: {
        id: "plan_live_1",
        source: "<h1>PRD: Live</h1>",
        phase: "composing"
      }
    })
    expect(actor.getSnapshot().context.planDraft?.source).toContain("PRD: Live")
    expect(actor.getSnapshot().context.planDraftPresentationNonce).toBe(1)
    expect(latestPlan(actor.getSnapshot().context.messages)).toBeNull()

    emit({
      _tag: "PlanDraft",
      draft: {
        id: "plan_live_1",
        source: "<h1>PRD: Live plan</h1><p>More</p>",
        phase: "complete"
      }
    })
    expect(actor.getSnapshot().context.planDraftPresentationNonce).toBe(1)

    emit({ _tag: "PlanProposed", plan: proposedPlan })
    const promoted = actor.getSnapshot().context
    expect(promoted.planDraft).toBeNull()
    expect(latestPlan(promoted.messages)?.raw).toBe(
      "<h1>PRD: Live plan</h1>"
    )
    actor.stop()
  })

  it("does not request presentation again after a reformat clear in the same turn", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "plan it" })
    await waitFor(actor, (s) => s.matches("running"))

    emit({
      _tag: "PlanDraft",
      draft: {
        id: "plan_live_1",
        source: "<h1>PRD: First</h1>",
        phase: "composing"
      }
    })
    emit({
      _tag: "PlanDraft",
      draft: { id: "plan_live_1", source: "", phase: "cleared" }
    })
    emit({
      _tag: "PlanDraft",
      draft: {
        id: "plan_live_1",
        source: "<h1>PRD: Reformatted</h1>",
        phase: "composing"
      }
    })

    expect(actor.getSnapshot().context.planDraftPresentationNonce).toBe(1)
    expect(actor.getSnapshot().context.planDraft?.source).toContain(
      "Reformatted"
    )
    actor.stop()
  })

  it("clears a volatile draft on failure and operator cancellation", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "plan it" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({
      _tag: "PlanDraft",
      draft: {
        id: "plan_live_1",
        source: "<h1>PRD: Partial</h1>",
        phase: "composing"
      }
    })
    emit({ _tag: "Failed", message: "Malformed plan." })
    expect(actor.getSnapshot().context.planDraft).toBeNull()

    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "try again" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({
      _tag: "PlanDraft",
      draft: {
        id: "plan_live_2",
        source: "<h1>PRD: Partial again</h1>",
        phase: "composing"
      }
    })
    actor.send({ type: "STOP" })
    expect(actor.getSnapshot().context.planDraft).toBeNull()
    actor.stop()
  })
})

describe("conversationMachine — PlanUpdated across turns", () => {
  /** A minimal one-step plan; only the id/status/steps matter to the fold. */
  const planFixture = (stepStatus: "proposed" | "done"): Plan =>
    ({
      id: "plan_1",
      summary: "Refactor auth",
      structured: true,
      graph: null,
      comments: [],
      status: "approved",
      raw: "# Refactor auth",
      steps: [
        {
          id: "s_01",
          number: "01",
          title: "Create TokenStore",
          intent: "A dedicated store.",
          approach: [],
          kind: "step",
          condition: null,
          parentId: null,
          dependsOn: [],
          blocks: [],
          files: [{ path: "src/auth/token-store.ts", change: "A", added: 40, removed: 0 }],
          guards: [],
          code: null,
          diff: null,
          status: stepStatus,
          flagged: false
        }
      ]
    }) as unknown as Plan

  const documentFixture = (
    stepStatus: "proposed" | "done",
    producingChatId = session.id,
    revision = 1
  ): PlanDocument => ({
    id: "plan_1",
    sessionId: session.id,
    producingChatId,
    revision,
    status: stepStatus === "done" ? "done" : "proposed",
    plan: {
      title: "PRD: Refactor auth",
      sections: [],
      stages: [
        {
          id: "s_01",
          title: "Create TokenStore",
          intent: "A dedicated store.",
          approach: [],
          files: [],
          diagrams: [],
          notes: [],
          acceptance: [
            {
              id: "a1",
              text: "Done",
              status: stepStatus === "done" ? "passed" : "pending",
              evidence: null
            }
          ]
        }
      ],
      annotations: []
    },
    updatedBy: "agent",
    updatedAt: "2026-07-25T00:01:00.000Z"
  })

  it("applies a PlanUpdated to the plan's own message, not the latest one", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    // Turn 1: the plan lands in this turn's assistant message.
    actor.send({ type: "SEND", text: "plan it" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "PlanProposed", plan: planFixture("proposed") })
    emit({ _tag: "Done", costUsd: 0, tokens: 0 })
    await waitFor(actor, (s) => s.matches(idle))

    // Turn 2: a fresh assistant message — the plan part is now behind us, which
    // is exactly when a patchLast fold would silently drop the update.
    actor.send({ type: "SEND", text: "implement it" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "PlanUpdated", plan: planFixture("done") })

    const plan = latestPlan(actor.getSnapshot().context.messages)
    expect(plan?.steps[0]!.status).toBe("done")
    actor.stop()
  })

  it("uses the shared artifact revision when the transcript has the same plan id", async () => {
    h.transcript = [
      applyStreamEvent(
        assistantMessage("a_plan", "2026-07-25T00:00:00.000Z"),
        { _tag: "PlanProposed", plan: planFixture("proposed") }
      )
    ]
    h.currentPlan = documentFixture("done")

    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))

    expect(latestPlan(actor.getSnapshot().context.messages)?.steps[0]?.status).toBe("done")
    actor.stop()
  })

  /**
   * The other half of the graft. A chat that never proposed the plan has no
   * message to graft onto, so the artifact has to arrive as one — otherwise the
   * Plan tab is empty in every chat but the one that produced it.
   *
   * Pinned because the load walk decides this from a flag it sets DURING the
   * walk (`grafted`), rather than by re-scanning the transcript afterwards. A
   * flag that was set eagerly, or never reset, would take this branch away and
   * the loss would be silent — a missing tab, not an error.
   */
  it("appends the shared artifact when no message in the transcript carries it", async () => {
    h.transcript = [userMessage("u_1", "morning", "2026-07-25T00:00:00.000Z")]
    h.currentPlan = documentFixture("done", "c_other", 3)

    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))

    const { messages } = actor.getSnapshot().context
    expect(messages).toHaveLength(2)
    expect(messages[1]!.id).toBe("a_shared_plan_3")
    expect(latestPlan(messages)?.steps[0]?.status).toBe("done")
    expect(actor.getSnapshot().context.sharedPlanChatId).toBe("c_other")
    actor.stop()
  })

  it("replaces the synthetic plan when paging reaches its original message", async () => {
    const original = applyStreamEvent(
      assistantMessage("a_original_plan", "2026-07-25T00:00:00.000Z"),
      { _tag: "PlanProposed", plan: planFixture("proposed") }
    )
    h.transcript = [
      original,
      ...Array.from({ length: 299 }, (_, index) =>
        userMessage(
          `u_${index}`,
          `turn ${index}`,
          "2026-07-25T00:00:00.000Z"
        )
      )
    ]
    h.currentPlan = documentFixture("done", "c_other", 4)

    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))
    expect(
      actor.getSnapshot().context.messages.filter((message) =>
        message.id.startsWith("a_shared_plan_")
      )
    ).toHaveLength(1)

    actor.send({ type: "LOAD_OLDER" })
    await waitFor(actor, (snapshot) => snapshot.context.messages.length === 300)

    const messages = actor.getSnapshot().context.messages
    expect(
      messages.filter((message) => message.id.startsWith("a_shared_plan_"))
    ).toHaveLength(0)
    expect(
      messages.flatMap((message) => message.parts).filter(
        (part) => part._tag === "Plan" && part.plan.id === "plan_1"
      )
    ).toHaveLength(1)
    expect(latestPlan(messages)?.steps[0]?.status).toBe("done")
    actor.stop()
  })

  /**
   * The load walk must not COPY a message it has nothing to change.
   *
   * Identity, not equality, is the assertion that means anything here: the walk
   * used to spread every message and rebuild every `parts` array to replace a
   * single Plan part, and transcripts on disk reach 44MB. Deep-equal would pass
   * against exactly that. The renderer's footprint is a high-water mark of these
   * loads — neither V8 nor PartitionAlloc return a spike's pages to the OS — so
   * a copy nobody needed is paid for permanently.
   */
  it("passes messages the artifact does not touch through by reference", async () => {
    const untouched = userMessage("u_1", "morning", "2026-07-25T00:00:00.000Z")
    const carrier = applyStreamEvent(
      assistantMessage("a_plan", "2026-07-25T00:00:30.000Z"),
      { _tag: "PlanProposed", plan: planFixture("proposed") }
    )
    h.transcript = [untouched, carrier]
    h.currentPlan = documentFixture("done")

    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))

    const { messages } = actor.getSnapshot().context
    // Nothing to settle and no plan of the artifact's id: the SAME object.
    expect(messages[0]).toBe(untouched)
    // The one that does carry it is rebuilt, and carries the newer revision.
    expect(messages[1]).not.toBe(carrier)
    expect(latestPlan(messages)?.steps[0]?.status).toBe("done")
    actor.stop()
  })

  it("applies a shared plan broadcast to an existing chat actor", async () => {
    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))

    actor.send({
      type: "SHARED_PLAN_UPDATED",
      plan: planFixture("done"),
      producingChatId: "c_other"
    })

    expect(latestPlan(actor.getSnapshot().context.messages)?.steps[0]?.status).toBe("done")
    expect(actor.getSnapshot().context.sharedPlanChatId).toBe("c_other")
    actor.stop()
  })

  it("rolls back an optimistic live approval when the canonical revision is stale", async () => {
    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))

    actor.send({ type: "SEND", text: "plan it" })
    await waitFor(actor, (snapshot) => snapshot.matches("running"))
    emit({ _tag: "PlanProposed", plan: planFixture("proposed") })

    h.approvalRefused = true
    actor.send({ type: "APPROVE_PLAN", planId: "plan_1", revision: 1 })

    await waitFor(actor, (snapshot) => snapshot.context.planActionError !== null)
    expect(actor.getSnapshot().matches("running")).toBe(true)
    expect(actor.getSnapshot().context.planActionError).toBe(
      "Canonical revision 2 replaced reviewed revision 1."
    )
    expect(latestPlan(actor.getSnapshot().context.messages)?.status).toBe("proposed")
    actor.stop()
  })
})

describe("conversationMachine — persisted session reconciliation", () => {
  it("keeps transient plan mode when a Codex model update echoes the persisted exec mode", async () => {
    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))
    actor.send({ type: "SET_MODE", mode: "plan" })

    const updated = {
      ...session,
      cli: "codex",
      model: "gpt-5.6-sol",
      activeChatId: session.id,
      chats: [{
        id: session.id,
        title: "Chat 1",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
        // Plan mode is transient and deliberately absent from persistence.
        mode: "accept-edits",
        model: "gpt-5.6-sol"
      }]
    } as Session

    actor.send({ type: "SESSION_UPDATED", session: updated })

    expect(actor.getSnapshot().context.cli).toBe("codex")
    expect(actor.getSnapshot().context.mode).toBe("plan")
    actor.stop()
  })

  it("refreshes provider, model, mode, and reasoning on an existing actor", async () => {
    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))
    const updated = {
      ...session,
      cli: "codex",
      model: "gpt-5.6-sol",
      mode: "auto",
      activeChatId: session.id,
      chats: [{
        id: session.id,
        title: "Chat 1",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
        mode: "auto",
        model: "gpt-5.6-sol"
      }],
      reasoning: { codex: { enabled: false, effort: "high" } }
    } as Session

    actor.send({ type: "SESSION_UPDATED", session: updated })

    expect(actor.getSnapshot().context).toMatchObject({
      cli: "codex",
      model: "gpt-5.6-sol",
      mode: "auto",
      reasoning: { enabled: false, effort: "high" }
    })
    actor.stop()
  })

  it("keeps a transient plan selection when a session sync lands", async () => {
    // REGRESSION: the backend never persists plan mode (`agent-runner.setMode`
    // holds it in memory and only writes the exec mode). A SESSION_UPDATED
    // therefore always carries a concrete mode, and reconcile used to adopt it
    // blindly — snapping the operator straight back out of plan into auto the
    // moment any sync landed.
    const actor = start()
    await waitFor(actor, (snapshot) => snapshot.matches(idle))
    actor.send({ type: "SET_MODE", mode: "plan" })
    expect(actor.getSnapshot().context.mode).toBe("plan")

    const updated = {
      ...session,
      activeChatId: session.id,
      mode: "auto",
      chats: [{
        id: session.id,
        title: "Chat 1",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
        mode: "auto",
        model: session.model
      }]
    } as Session

    actor.send({ type: "SESSION_UPDATED", session: updated })

    // The overlay survives the sync…
    expect(actor.getSnapshot().context.mode).toBe("plan")
    // …while the restore-on-approval exec mode still tracks the backend.
    expect(actor.getSnapshot().context.executionMode).toBe("auto")
    actor.stop()
  })
})

describe("conversationMachine — stop", () => {
  it("settles the halted turn instead of leaving it streaming forever", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))

    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    emit({ _tag: "Assistant", text: "working…" })
    expect(actor.getSnapshot().context.messages.at(-1)!.streaming).toBe(true)

    actor.send({ type: "STOP" })

    // The runner's own terminal event can't help here: STOP leaves `running`,
    // and STREAM_EVENT is only handled there. The machine must settle it itself.
    const last = actor.getSnapshot().context.messages.at(-1)!
    expect(last.streaming).toBe(false)
    expect(last.parts.some((p) => p._tag === "Text" && p.text === STOPPED_NOTE)).toBe(true)
    actor.stop()
  })

  it("asks the main process to stop the agent, and drops the queue", async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    actor.send({ type: "SEND", text: "queued" })
    expect(actor.getSnapshot().context.queued).toHaveLength(1)

    actor.send({ type: "STOP" })

    expect(h.stopCalls).toContain("s1")
    expect(actor.getSnapshot().context.queued).toEqual([])
    actor.stop()
  })

  /**
   * The renderer half of the silent-turn fix.
   *
   * `callStop` used to be fire-and-forget: the machine asked main to halt the
   * run and transitioned onward in the same breath, so the interrupt could land
   * after the NEXT turn had been forked and kill that instead. The operator's
   * fresh message came back as a bare "Stopped." and they re-sent it. Going
   * through `stopping` means the halt has landed before anything can start.
   */
  it("waits in `stopping` until the halt lands, before any next turn", async () => {
    let releaseStop = () => {}
    h.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))
    actor.send({ type: "SEND", text: "next" })

    actor.send({ type: "SEND_NOW", id: queuedId(actor, 0) })

    // Not `running` yet — the promoted message must not start until the stop
    // has been acknowledged. This is the assertion the old code failed.
    await waitFor(actor, (s) => s.matches("stopping"))
    expect(actor.getSnapshot().matches("stopping")).toBe(true)
    expect(h.stopCalls).toContain("s1")

    // …and once it has, the promoted message runs as normal.
    releaseStop()
    await waitFor(actor, (s) => s.matches("running"))
    expect(actor.getSnapshot().context.pendingText).toBe("next")
    actor.stop()
  })

  // Every exit from `stopping` leads onward, including the unhappy ones: a stop
  // that rejects must never strand the session in a state with no composer.
  it("moves on even when the stop RPC fails", async () => {
    h.stopFails = true
    const actor = start()
    await waitFor(actor, (s) => s.matches(idle))
    actor.send({ type: "SEND", text: "go" })
    await waitFor(actor, (s) => s.matches("running"))

    actor.send({ type: "STOP" })

    await waitFor(actor, (s) => s.matches(idle))
    expect(actor.getSnapshot().context.messages.at(-1)!.streaming).toBe(false)
    actor.stop()
  })
})
