import { createServer, type Server, type Socket } from "node:net"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DirectSessionOpen, EncryptedTunnelEnvelope } from "@jingler/core"
import {
  DirectSessionOpen as DirectSessionOpenSchema,
  RemoteSessionCommand as RemoteSessionCommandSchema,
  TunnelClientMessage as TunnelClientMessageSchema
} from "@jingler/core"
import {
  decryptRemotePayload,
  deriveDeviceSessionKey,
  encryptRemotePayload
} from "@jingler/cli-adapters/remote-session"
import { Schema } from "effect"
import type { DeviceEnrollment } from "./control-connection.js"
import type { DeviceIdentity } from "./device-identity.js"
import { SessionCommandHandler } from "./session-handler.js"

const MAX_FRAME_BYTES = 1_100_000

const writeFrame = (socket: Socket, value: unknown): void => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`)
}

const serveConnection = async (
  socket: Socket,
  enrollment: DeviceEnrollment,
  identity: DeviceIdentity,
  handlerFor: (sessionId: string) => SessionCommandHandler
): Promise<void> => {
  socket.setEncoding("utf8")
  let buffer = ""
  let opened: DirectSessionOpen | null = null
  let key: Uint8Array | null = null
  let serial = Promise.resolve()
  let flushSerial = Promise.resolve()
  const flush = async (handler: SessionCommandHandler, commandId?: string): Promise<void> => {
    if (!opened || !key) return
    if (commandId) {
      await handler.prepareOutgoingEnvelopes(commandId, (event, sequence) =>
        encryptRemotePayload(key!, opened!.sessionId, sequence, "device", event)
      )
    }
    const pending = await handler.pendingOutgoingEnvelopes(opened.acknowledgedSequence)
    for (const envelope of pending) writeFrame(socket, { type: "envelope", envelope })
    const transport = await handler.transportState()
    writeFrame(socket, { type: "peer-acknowledged", sequence: transport.acknowledgedDesktopSequence })
  }
  const scheduleFlush = (handler: SessionCommandHandler, commandId?: string): Promise<void> => {
    const operation = flushSerial.then(() => flush(handler, commandId))
    flushSerial = operation.catch(() => undefined)
    return operation
  }
  const accept = async (line: string): Promise<void> => {
    const raw: unknown = JSON.parse(line)
    if (!opened) {
      opened = Schema.decodeUnknownSync(DirectSessionOpenSchema)(raw, { onExcessProperty: "error" })
      if (opened.keyOffer.subject !== enrollment.subject || opened.keyOffer.deviceId !== enrollment.deviceId) {
        throw new Error("Direct session does not belong to this enrolled device.")
      }
      key = deriveDeviceSessionKey(opened.keyOffer, identity.deriveSessionSecret, {
        subject: enrollment.subject,
        deviceId: enrollment.deviceId,
        sessionId: opened.sessionId
      })
      const handler = handlerFor(opened.sessionId)
      await handler.adoptControllerScope({
        clientInstanceId: opened.clientInstanceId,
        attachmentGeneration: opened.attachmentGeneration,
        controllerLeaseGeneration: opened.controllerLeaseGeneration
      })
      const transport = await handler.transportState()
      writeFrame(socket, {
        type: "hello",
        nextSequence: transport.highestReceivedDesktopSequence + 1,
        acknowledgedSequence: transport.acknowledgedOutgoingSequence
      })
      await scheduleFlush(handler)
      return
    }
    const message = Schema.decodeUnknownSync(TunnelClientMessageSchema)(raw, { onExcessProperty: "error" })
    const handler = handlerFor(opened.sessionId)
    if (message.type === "ping") return writeFrame(socket, { type: "pong" })
    if (message.type === "resume") {
      opened = { ...opened, acknowledgedSequence: message.acknowledgedSequence }
      return scheduleFlush(handler)
    }
    if (message.type === "ack") {
      if (message.acknowledgement.sessionId !== opened.sessionId || message.acknowledgement.sender !== "desktop") {
        throw new Error("Invalid direct session acknowledgement.")
      }
      opened = { ...opened, acknowledgedSequence: message.acknowledgement.acknowledgedSequence }
      await handler.acknowledgeOutgoing(message.acknowledgement.acknowledgedSequence)
      return
    }
    if (message.type !== "envelope") throw new Error("Unsupported direct session frame.")
    const envelope: EncryptedTunnelEnvelope = message.envelope
    if (envelope.sessionId !== opened.sessionId || envelope.sender !== "desktop") {
      throw new Error("Direct envelope resource mismatch.")
    }
    const command = decryptRemotePayload(key!, envelope, RemoteSessionCommandSchema)
    const scope = {
      clientInstanceId: opened.clientInstanceId,
      attachmentGeneration: opened.attachmentGeneration,
      controllerLeaseGeneration: opened.controllerLeaseGeneration
    }
    const before = await handler.transportState()
    const duplicate = envelope.sequence <= before.highestReceivedDesktopSequence
    await handler.handle(
      command,
      envelope.sequence,
      (commandId) => scheduleFlush(handler, commandId),
      scope
    )
    scheduleFlush(handler, command.commandId)
    writeFrame(socket, { type: "envelope-result", status: duplicate ? "duplicate" : "inserted", sequence: envelope.sequence })
  }
  socket.on("data", (chunk: string) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return socket.destroy()
    while (true) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      serial = serial.then(() => accept(line)).catch(() => { socket.destroy() })
    }
  })
}

export const startDirectSessionServer = async (input: {
  readonly enrollment: DeviceEnrollment
  readonly identity: DeviceIdentity
  readonly handlerFor: (sessionId: string) => SessionCommandHandler
}): Promise<{ readonly socketPath: string; readonly close: () => Promise<void> }> => {
  // A random 0700 parent is the local admission boundary. The socket is never
  // reachable during the listen/chmod interval, and another local account
  // cannot predict and pre-bind its path.
  const socketDirectory = await mkdtemp(join(tmpdir(), "jingler-device-"))
  await chmod(socketDirectory, 0o700)
  const socketPath = join(socketDirectory, "session.sock")
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    void serveConnection(socket, input.enrollment, input.identity, input.handlerFor)
      .catch(() => socket.destroy())
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })
    await chmod(socketPath, 0o600)
  } catch (error) {
    if (server.listening) server.close()
    await rm(socketDirectory, { recursive: true, force: true })
    throw error
  }
  return {
    socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(socketDirectory, { recursive: true, force: true })
    }
  }
}
