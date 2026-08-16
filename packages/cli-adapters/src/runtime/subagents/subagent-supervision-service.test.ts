import { SUBAGENT_FLEET_PROTOCOL_VERSION } from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
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
})
