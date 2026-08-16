import { SUBAGENT_FLEET_PROTOCOL_VERSION } from "@jingler/core"
import { Deferred, Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  makeSubagentSupervisionService,
  SubagentSupervisionService,
  SubagentSupervisionServiceLive
} from "./subagent-supervision-service.js"

describe("SubagentSupervisionService", () => {
  it("owns registry state atomically and finalizes subscriptions with its layer scope", async () => {
    const unsubscribe = vi.fn()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const service = yield* SubagentSupervisionService
      expect(yield* service.start(() => [unsubscribe])).toBe(true)
      expect(yield* service.start(() => [])).toBe(false)
      const identity = yield* service.identity("run-1", "run-1")
      yield* service.publish({
        _tag: "Upsert",
        version: SUBAGENT_FLEET_PROTOCOL_VERSION,
        eventId: "event-1",
        occurredAt: 1,
        node: {
          ...identity,
          runId: "run-1",
          parentId: null,
          parentPiSessionId: "parent",
          agent: "worker",
          task: "Inspect",
          model: null,
          status: "running",
          background: true,
          sessionFile: null,
          currentTool: null,
          startedAt: 1,
          updatedAt: 1,
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
      })
      const state = yield* service.state
      expect(state.tree.nodes.map(({ subagentId }) => subagentId)).toEqual(["run-1"])
      expect(yield* service.replay(0)).toHaveLength(1)
    }).pipe(Effect.provide(SubagentSupervisionServiceLive("parent")))))
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it("serializes controls and returns one outcome for duplicate request ids", async () => {
    const service = Effect.runSync(makeSubagentSupervisionService("parent"))
    const started = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    const executionOrder: string[] = []
    const request = (requestId: string) => ({
      version: 2 as const,
      requestId,
      parentPiSessionId: "parent",
      runId: "run-1",
      action: "steer" as const,
      message: "Continue",
      replyTo: null
    })
    const execute = (requestId: string) => (sequence: number) => Effect.gen(function* () {
      executionOrder.push(requestId)
      if (requestId === "one") {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      }
      return {
        version: 2 as const,
        requestId,
        runId: "run-1",
        action: "steer" as const,
        acknowledged: true,
        status: "accepted" as const,
        deliveryStatus: "delivered" as const,
        sequence,
        nativeRequestId: `native-${requestId}`,
        message: "delivered",
        acknowledgedAt: sequence
      }
    })

    const first = Effect.runPromise(service.submitControl(request("one"), execute("one")))
    await Effect.runPromise(Deferred.await(started))
    const second = Effect.runPromise(service.submitControl(request("two"), execute("two")))
    const duplicate = Effect.runPromise(service.submitControl(request("two"), execute("duplicate")))
    Effect.runSync(Deferred.succeed(release, undefined))
    const [one, two, sameTwo] = await Promise.all([first, second, duplicate])

    expect(executionOrder).toEqual(["one", "two"])
    expect([one.sequence, two.sequence]).toEqual([1, 2])
    expect(sameTwo).toEqual(two)
    expect(Effect.runSync(service.controlReceipts).map(({ status }) => status))
      .toEqual(["queued", "queued", "delivered", "delivered"])
  })
})
