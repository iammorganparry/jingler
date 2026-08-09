import { createConnection } from "node:net"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  decryptRemotePayload,
  encryptRemotePayload,
  establishDesktopSessionKey
} from "@jingler/cli-adapters/remote-session"
import { RemoteSessionEvent } from "@jingler/core"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { loadOrCreateDeviceIdentity } from "./device-identity.js"
import { startDirectSessionServer } from "./direct-session-server.js"
import { SessionCommandHandler } from "./session-handler.js"

describe("direct session server", () => {
  let root = ""
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it("uses the shared encrypted tunnel protocol without a relay", async () => {
    root = await mkdtemp(join(tmpdir(), "jingler-direct-session-"))
    const identity = await Effect.runPromise(loadOrCreateDeviceIdentity(join(root, "identity.json")))
    const sessionId = "session_abcdefghijklmnop"
    const deviceId = "device_abcdefghijklmnop"
    const desktop = establishDesktopSessionKey({
      subject: "user@example.com",
      deviceId,
      sessionId,
      devicePublicKey: identity.encryptionPublicKey
    })
    const handler = new SessionCommandHandler(join(root, "session.json"), {
      execute: async () => ({ ok: true })
    })
    const server = await startDirectSessionServer({
      enrollment: { subject: "user@example.com", deviceId, serverUrl: "https://example.test" },
      identity,
      handlerFor: () => handler
    })
    expect((await stat(dirname(server.socketPath))).mode & 0o777).toBe(0o700)
    expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600)
    const socket = createConnection(server.socketPath)
    socket.setEncoding("utf8")
    const frames: unknown[] = []
    let text = ""
    socket.on("data", (chunk: string) => {
      text += chunk
      const lines = text.split("\n")
      text = lines.pop() ?? ""
      for (const line of lines) if (line) frames.push(JSON.parse(line))
    })
    await new Promise<void>((resolve) => socket.once("connect", resolve))
    socket.write(`${JSON.stringify({
      type: "direct-open", version: 1, sessionId, acknowledgedSequence: 0,
      keyOffer: desktop.offer, clientInstanceId: "client_abcdefghijklmnop",
      attachmentGeneration: 1, controllerLeaseGeneration: 1
    })}\n`)
    await expect.poll(() => frames.some((frame) => (frame as { type?: string }).type === "hello")).toBe(true)
    const command = { version: 1 as const, commandId: "command_abcdefghijklmnop", sessionId, operation: "test", payload: {} }
    socket.write(`${JSON.stringify({
      type: "envelope",
      envelope: encryptRemotePayload(desktop.key, sessionId, 1, "desktop", command)
    })}\n`)
    await expect.poll(() => frames.filter((frame) => (frame as { type?: string }).type === "envelope").length).toBeGreaterThan(0)
    const eventFrame = frames.find((frame) => (frame as { type?: string }).type === "envelope") as { envelope: Parameters<typeof decryptRemotePayload>[1] }
    const event = decryptRemotePayload(desktop.key, eventFrame.envelope, RemoteSessionEvent)
    expect(event).toMatchObject({ commandId: command.commandId, sessionId })
    expect(Schema.is(RemoteSessionEvent)(event)).toBe(true)
    socket.destroy()
    await server.close()
  })
})
