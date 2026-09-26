import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SUBAGENT_FLEET_PROTOCOL_VERSION } from "@jingler/core"
import { Deferred, Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  makeSubagentControlJournal,
  makeSubagentSupervisionService,
  SubagentSupervisionService,
  SubagentSupervisionServiceLive
} from "./subagent-supervision-service.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true
  })))
})

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
          parentRuntimeSessionId: "parent",
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
      parentRuntimeSessionId: "parent",
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

  it("rejects reuse of an idempotency key with a different control payload", async () => {
    const service = Effect.runSync(makeSubagentSupervisionService("parent"))
    const execute = vi.fn((sequence: number) => Effect.succeed({
      version: 2 as const,
      requestId: "same-id",
      runId: "run-1",
      action: "steer" as const,
      acknowledged: true,
      status: "accepted" as const,
      deliveryStatus: "delivered" as const,
      sequence,
      nativeRequestId: "native-1",
      message: "delivered",
      acknowledgedAt: 1
    }))
    const original = {
      version: 2 as const,
      requestId: "same-id",
      parentRuntimeSessionId: "parent",
      runId: "run-1",
      action: "steer" as const,
      message: "Continue",
      replyTo: null
    }
    await Effect.runPromise(service.submitControl(original, execute))
    const collision = await Effect.runPromise(service.submitControl({
      ...original,
      message: "Stop instead"
    }, execute))

    expect(collision).toMatchObject({
      acknowledged: false,
      status: "rejected",
      deliveryStatus: "rejected",
      message: "Control request ID cannot be verified against the original payload"
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it("serializes journal replacements so an older snapshot cannot land last", async () => {
    const finalSaveStarted = Effect.runSync(Deferred.make<void>())
    const releaseFinalSave = Effect.runSync(Deferred.make<void>())
    const landed: Array<{ readonly outcomes: ReadonlyArray<{ readonly requestId: string }> }> = []
    let saveCount = 0
    const service = Effect.runSync(makeSubagentSupervisionService(
      "parent",
      () => saveCount,
      {
        load: Effect.succeed({
          version: 2 as const,
          parentRuntimeSessionId: "parent",
          sequence: 0,
          pending: [],
          outcomes: [],
          requests: [],
          receipts: []
        }),
        save: (journal) => Effect.gen(function* () {
          saveCount += 1
          if (saveCount === 2) {
            yield* Deferred.succeed(finalSaveStarted, undefined)
            yield* Deferred.await(releaseFinalSave)
          }
          landed.push(journal)
        })
      }
    ))
    const request = (requestId: string) => ({
      version: 2 as const,
      requestId,
      parentRuntimeSessionId: "parent",
      runId: requestId,
      action: "stop" as const,
      message: null,
      replyTo: null
    })
    const execute = (requestId: string) => (sequence: number) => Effect.succeed({
      version: 2 as const,
      requestId,
      runId: requestId,
      action: "stop" as const,
      acknowledged: true,
      status: "accepted" as const,
      deliveryStatus: "delivered" as const,
      sequence,
      nativeRequestId: `native-${requestId}`,
      message: "delivered",
      acknowledgedAt: sequence
    })

    const first = Effect.runPromise(service.submitControl(request("one"), execute("one")))
    await Effect.runPromise(Deferred.await(finalSaveStarted))
    const second = Effect.runPromise(service.submitControl(request("two"), execute("two")))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveCount).toBe(2)
    Effect.runSync(Deferred.succeed(releaseFinalSave, undefined))
    await Promise.all([first, second])

    expect(landed.at(-1)?.outcomes.map(({ requestId }) => requestId).sort())
      .toEqual(["one", "two"])
  })

  it("fails closed without native execution when durable receipts are unavailable", async () => {
    const execute = vi.fn(() => Effect.die("must not execute"))
    const service = Effect.runSync(makeSubagentSupervisionService(
      "parent",
      () => 5,
      {
        load: Effect.fail(new Error("journal unavailable")),
        save: () => Effect.void
      }
    ))
    const outcome = await Effect.runPromise(service.submitControl({
      version: 2,
      requestId: "closed-request",
      parentRuntimeSessionId: "parent",
      runId: "run-1",
      action: "stop",
      message: null,
      replyTo: null
    }, execute))

    expect(outcome).toMatchObject({
      acknowledged: false,
      status: "rejected",
      deliveryStatus: "rejected",
      message: "journal unavailable"
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it("fails closed for cached outcomes whose original payload was not journaled", async () => {
    const execute = vi.fn(() => Effect.die("must not execute"))
    const service = Effect.runSync(makeSubagentSupervisionService(
      "parent",
      () => 3,
      {
        load: Effect.succeed({
          version: 2 as const,
          parentRuntimeSessionId: "parent",
          sequence: 1,
          pending: [],
          outcomes: [{
            version: 2 as const,
            requestId: "legacy-cache",
            runId: "run-1",
            action: "stop" as const,
            acknowledged: true,
            status: "accepted" as const,
            deliveryStatus: "delivered" as const,
            sequence: 1,
            nativeRequestId: "native-1",
            message: "delivered",
            acknowledgedAt: 1
          }],
          receipts: []
        }),
        save: () => Effect.void
      }
    ))

    const outcome = await Effect.runPromise(service.submitControl({
      version: 2,
      requestId: "legacy-cache",
      parentRuntimeSessionId: "parent",
      runId: "run-1",
      action: "stop",
      message: null,
      replyTo: null
    }, execute))

    expect(outcome).toMatchObject({
      acknowledged: false,
      status: "rejected",
      message: "Control request ID cannot be verified against the original payload"
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it("migrates persisted version-2 parentPiSessionId journals", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-control-journal-"))
    roots.push(root)
    const directory = join(root, ".jingler-supervision")
    await mkdir(directory, { recursive: true })
    const request = { version: 2, requestId: "legacy-request", parentPiSessionId: "parent", runId: "run-1", action: "stop", message: null, replyTo: null }
    await writeFile(join(directory, `${createHash("sha256").update("parent").digest("hex")}.json`), JSON.stringify({
      version: 2, parentPiSessionId: "parent", sequence: 1,
      pending: [{ request, sequence: 1 }], outcomes: [], requests: [request],
      receipts: [{ version: 2, messageId: "legacy-receipt", parentPiSessionId: "parent", subagentId: "worker", sequence: 1, status: "delivered", occurredAt: 1, message: null }]
    }))
    const loaded = await Effect.runPromise(makeSubagentControlJournal({ asyncDir: root, parentRuntimeSessionId: "parent" }).load)
    expect(loaded.parentRuntimeSessionId).toBe("parent")
    expect(loaded.pending[0]?.request.parentRuntimeSessionId).toBe("parent")
    expect(loaded.requests?.[0]?.parentRuntimeSessionId).toBe("parent")
    expect(loaded.receipts[0]?.parentRuntimeSessionId).toBe("parent")
  })

  it("restores accepted outcomes without reapplying native controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-control-journal-"))
    roots.push(root)
    const journal = makeSubagentControlJournal({
      asyncDir: root,
      parentRuntimeSessionId: "parent"
    })
    const request = {
      version: 2 as const,
      requestId: "durable-request",
      parentRuntimeSessionId: "parent",
      runId: "run-1",
      action: "steer" as const,
      message: "Continue",
      replyTo: null
    }
    const execute = vi.fn((sequence: number) => Effect.succeed({
      version: 2 as const,
      requestId: request.requestId,
      runId: request.runId,
      action: request.action,
      acknowledged: true,
      status: "accepted" as const,
      deliveryStatus: "delivered" as const,
      sequence,
      nativeRequestId: "native-durable",
      message: "delivered",
      acknowledgedAt: 2
    }))
    const first = Effect.runSync(makeSubagentSupervisionService(
      "parent",
      () => 1,
      journal
    ))
    const accepted = await Effect.runPromise(first.submitControl(request, execute))
    const restarted = Effect.runSync(makeSubagentSupervisionService(
      "parent",
      () => 3,
      journal
    ))

    const restored = await Effect.runPromise(restarted.submitControl(request, execute))
    const collision = await Effect.runPromise(restarted.submitControl({
      ...request,
      message: "Different payload"
    }, execute))

    expect(restored).toEqual(accepted)
    expect(collision).toMatchObject({
      acknowledged: false,
      status: "rejected",
      message: "Control request ID cannot be verified against the original payload"
    })
    expect(execute).toHaveBeenCalledOnce()
  })
})
