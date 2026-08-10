import { describe, expect, it, vi } from "vitest"
import { createVerifiedWorkspaceHandoff } from "./atomic-handoff.js"
import type { CheckpointSandbox } from "./workspace-checkpoint.js"

const digest = "a".repeat(64)
const head = "b".repeat(40)
const archive = () => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([1]))
    controller.close()
  }
})

const sandbox = (): CheckpointSandbox => ({
  exec: vi.fn(async (command: string) => ({
    success: true,
    stdout: command.includes("rev-parse")
      ? `${head}\nfeature/cloud\n1\n1\n`
      : command.includes("find . -type d")
        ? "1024\n"
        : digest,
    stderr: ""
  })),
  readFile: vi.fn(async () => ({ success: true as const, content: archive(), size: 1 })),
  writeFile: vi.fn(async () => ({ success: true })),
  deleteFile: vi.fn(async () => ({ success: true }))
})

describe("atomic managed workspace handoff", () => {
  it("acknowledges cutover only after target restore identity is verified", async () => {
    const order: string[] = []
    const source = sandbox()
    const target = sandbox()
    vi.mocked(target.writeFile).mockImplementation(async () => {
      order.push("restore")
      return { success: true }
    })
    const checkpointStore = {
      put: async (_key: string, value: string | ReadableStream<Uint8Array>) => {
        if (typeof value === "string") order.push("checkpoint")
      },
      get: async () => archive()
    }
    const result = await createVerifiedWorkspaceHandoff(
      source,
      target,
      checkpointStore,
      {
        checkpointId: "checkpoint_1",
        subject: "user_1",
        environmentId: "managed_1",
        sessionId: "session_1",
        previousCheckpoint: null,
        eventCursor: 42,
        nowSeconds: 100,
        retentionSeconds: 604_800
      },
      async () => {
        order.push("provision")
      }
    )
    order.push("ack")
    expect(order).toEqual(["checkpoint", "provision", "restore", "ack"])
    expect(result).toMatchObject({ verified: true, eventCursor: 42 })
    expect(source.writeFile).not.toHaveBeenCalled()
  })

  it("never acknowledges a mismatched target workspace", async () => {
    const source = sandbox()
    const target = sandbox()
    vi.mocked(target.exec).mockImplementation(async (command: string) => ({
      success: true,
      stdout: command.includes("rev-parse")
        ? `${head}\nwrong-branch\n1\n1\n`
        : command.includes("find . -type d")
          ? "1024\n"
          : digest,
      stderr: ""
    }))
    await expect(
      createVerifiedWorkspaceHandoff(
        source,
        target,
        { put: async () => undefined, get: async () => archive() },
        {
          checkpointId: "checkpoint_1",
          subject: "user_1",
          environmentId: "managed_1",
          sessionId: "session_1",
          previousCheckpoint: null,
          eventCursor: 42,
          nowSeconds: 100,
          retentionSeconds: 604_800
        },
        async () => undefined
      )
    ).rejects.toThrow("does not match")
  })
})
