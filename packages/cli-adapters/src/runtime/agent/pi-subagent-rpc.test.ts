import { createEventBus } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { makePiSubagentAsyncDelegate } from "./pi-subagent-rpc.js"

const REQUEST_EVENT = "subagents:rpc:v1:request"
const REPLY_PREFIX = "subagents:rpc:v1:reply:"

describe("pi subagent RPC", () => {
  it("returns the allocated async run", async () => {
    const events = createEventBus()
    events.on(REQUEST_EVENT, (value) => {
      const request = value as { requestId: string; params: unknown }
      expect(request.params).toMatchObject({ agent: "reviewer", async: true })
      events.emit(`${REPLY_PREFIX}${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: {
          text: "started",
          details: { asyncId: "run-1", asyncDir: "/tmp/run-1" }
        }
      })
    })
    await expect(makePiSubagentAsyncDelegate(events)({
      agent: "reviewer",
      task: "Review",
      cwd: "/workspace"
    }, new AbortController().signal)).resolves.toEqual({
      runId: "run-1",
      asyncDir: "/tmp/run-1",
      text: "started"
    })
  })

  it("fails closed on RPC errors and malformed replies", async () => {
    const errorEvents = createEventBus()
    errorEvents.on(REQUEST_EVENT, (value) => {
      const { requestId } = value as { requestId: string }
      errorEvents.emit(`${REPLY_PREFIX}${requestId}`, {
        version: 1,
        requestId,
        success: false,
        error: { code: "no_active_session", message: "No active extension context" }
      })
    })
    await expect(makePiSubagentAsyncDelegate(errorEvents)({
      agent: "reviewer",
      task: "Review",
      cwd: "/workspace"
    }, new AbortController().signal)).rejects.toThrow("No active extension context")

    const malformedEvents = createEventBus()
    malformedEvents.on(REQUEST_EVENT, (value) => {
      const { requestId } = value as { requestId: string }
      malformedEvents.emit(`${REPLY_PREFIX}${requestId}`, {
        version: 1,
        requestId,
        success: true,
        data: { details: {} }
      })
    })
    await expect(makePiSubagentAsyncDelegate(malformedEvents)({
      agent: "reviewer",
      task: "Review",
      cwd: "/workspace"
    }, new AbortController().signal)).rejects.toThrow("details.asyncId")
  })

  it("cancels and times out without leaving a listener", async () => {
    const cancelledEvents = createEventBus()
    const controller = new AbortController()
    const cancelled = makePiSubagentAsyncDelegate(cancelledEvents)(
      { agent: "reviewer", task: "Review", cwd: "/workspace" },
      controller.signal
    )
    controller.abort(new Error("cancelled"))
    await expect(cancelled).rejects.toThrow("cancelled")

    const timeoutEvents = createEventBus()
    await expect(makePiSubagentAsyncDelegate(timeoutEvents, 5)(
      { agent: "reviewer", task: "Review", cwd: "/workspace" },
      new AbortController().signal
    )).rejects.toThrow("timed out")
  })
})
