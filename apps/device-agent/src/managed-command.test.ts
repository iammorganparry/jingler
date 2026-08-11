import type { RemoteSessionCommand } from "@jingler/core"
import { describe, expect, it, vi } from "vitest"
import { runManagedCommand } from "./managed-command.js"

const command: RemoteSessionCommand = {
  version: 1,
  commandId: "command_1",
  sessionId: "session_1",
  operation: "Agent.run",
  payload: { chatId: "chat_1", text: "hello" }
}

describe("managed command runner", () => {
  it("adapts the owned-device executor to streamed managed frames", async () => {
    const frames: unknown[] = []
    const execute = vi.fn(async (_command, emit) => {
      await emit({ kind: "event", payload: { type: "text", text: "hello" } })
      return { status: "complete" }
    })
    await runManagedCommand(command, { execute }, (frame) => frames.push(frame))
    expect(execute).toHaveBeenCalledWith(command, expect.any(Function))
    expect(frames).toEqual([
      {
        type: "managed-event",
        event: { kind: "event", payload: { type: "text", text: "hello" } }
      },
      { type: "managed-complete", payload: { status: "complete" } }
    ])
  })

  it("returns a bounded failed frame instead of leaking executor errors", async () => {
    const frames: unknown[] = []
    await runManagedCommand(
      command,
      { execute: async () => { throw new Error("provider unavailable") } },
      (frame) => frames.push(frame)
    )
    expect(frames).toEqual([
      {
        type: "managed-failed",
        payload: { code: "operation-failed", message: "provider unavailable" }
      }
    ])
  })
})
