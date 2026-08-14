import { createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from "node:crypto"
import { once } from "node:events"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  DeviceRelayGrantResponse,
  RemoteDevice,
  RemoteSessionEvent
} from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import { Chunk, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { WebSocketServer } from "ws"
import { EnvironmentService, environmentFromRemoteDevice } from "./environment.js"
import { makeInMemorySecretStore, SecretStore } from "./secret-store.js"
import {
  decryptRemotePayload,
  deriveDeviceSessionKey,
  encryptRemotePayload,
  establishDesktopSessionKey,
  makeRemoteSessionStateRepository,
  openRemoteTunnel,
  openSshRemoteTunnel,
  RemoteSessionService,
  requestSessionIdForEnvironment,
  restoreDesktopSessionKey
} from "./remote-session.js"

const servers: WebSocketServer[] = []
const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("RemoteSessionService envelopes", () => {
  it("derives the same key without sending it through the relay", () => {
    const device = generateKeyPairSync("x25519"); const jwk = device.publicKey.export({ format: "jwk" }); if (!jwk.x) throw new Error("missing x")
    const desktop = establishDesktopSessionKey({ subject: "user", deviceId: "buildbox", sessionId: "session", devicePublicKey: { algorithm: "X25519", encoding: "base64url", value: jwk.x } })
    const deviceKey = deriveDeviceSessionKey(desktop.offer, (remote) => new Uint8Array(diffieHellman({ privateKey: device.privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: remote.value }, format: "jwk" }) })), { subject: "user", deviceId: "buildbox", sessionId: "session" })
    expect(Buffer.from(deviceKey)).toEqual(Buffer.from(desktop.key))
  })
  it("rejects a session-key offer for the wrong device", () => {
    const device = generateKeyPairSync("x25519"); const jwk = device.publicKey.export({ format: "jwk" }); if (!jwk.x) throw new Error("missing x")
    const desktop = establishDesktopSessionKey({ subject: "user", deviceId: "buildbox", sessionId: "session", devicePublicKey: { algorithm: "X25519", encoding: "base64url", value: jwk.x } })
    expect(() => deriveDeviceSessionKey(desktop.offer, () => randomBytes(32), { subject: "user", deviceId: "other", sessionId: "session" })).toThrow("resource mismatch")
  })
  it("restores the same derived key after a desktop process restart", () => {
    const device = generateKeyPairSync("x25519"); const jwk = device.publicKey.export({ format: "jwk" }); if (!jwk.x) throw new Error("missing x")
    const desktop = establishDesktopSessionKey({ subject: "user", deviceId: "buildbox", sessionId: "session", devicePublicKey: { algorithm: "X25519", encoding: "base64url", value: jwk.x } })
    const restored = restoreDesktopSessionKey({ offer: desktop.offer, privateKey: desktop.privateKey, devicePublicKey: { algorithm: "X25519", encoding: "base64url", value: jwk.x } })
    expect(Buffer.from(restored)).toEqual(Buffer.from(desktop.key))
  })
  it("rejects restored state with the wrong device key", () => {
    const device = generateKeyPairSync("x25519"); const other = generateKeyPairSync("x25519")
    const jwk = device.publicKey.export({ format: "jwk" }); const otherJwk = other.publicKey.export({ format: "jwk" }); if (!jwk.x || !otherJwk.x) throw new Error("missing x")
    const desktop = establishDesktopSessionKey({ subject: "user", deviceId: "buildbox", sessionId: "session", devicePublicKey: { algorithm: "X25519", encoding: "base64url", value: jwk.x } })
    const wrong = restoreDesktopSessionKey({ offer: desktop.offer, privateKey: desktop.privateKey, devicePublicKey: { algorithm: "X25519", encoding: "base64url", value: otherJwk.x } })
    expect(Buffer.from(wrong)).not.toEqual(Buffer.from(desktop.key))
  })
  it("encrypts session commands for the paired device key", () => {
    const key = randomBytes(32); const envelope = encryptRemotePayload(key, "s_remote", 1, "desktop", { prompt: "secret" }, 1)
    expect(envelope.ciphertext).not.toContain("secret")
    expect(decryptRemotePayload(key, envelope, Schema.Struct({ prompt: Schema.String }))).toEqual({ prompt: "secret" })
  })
  it("rejects a tampered encrypted event", () => {
    const key = randomBytes(32); const envelope = encryptRemotePayload(key, "s_remote", 1, "device", { value: 1 }, 1)
    expect(() => decryptRemotePayload(key, { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}A` }, Schema.Unknown)).toThrow("authentication failed")
  })
  it("maps encrypted remote events to StreamEvent values", () => {
    const key = randomBytes(32); const event = { version: 1 as const, commandId: "cmd_1", sessionId: "s_remote", eventSequence: 1, kind: "event" as const, payload: { type: "text", text: "hello" } }
    const decoded = decryptRemotePayload(key, encryptRemotePayload(key, "s_remote", 1, "device", event, 1), Schema.Unknown)
    expect(decoded).toEqual(event)
  })
  it("reuses one bounded request channel per environment", () => {
    const first = requestSessionIdForEnvironment("device_buildbox", "desktop_one_abcdefgh")
    expect(requestSessionIdForEnvironment("device_buildbox", "desktop_one_abcdefgh")).toBe(first)
    expect(requestSessionIdForEnvironment("device_other", "desktop_one_abcdefgh")).not.toBe(first)
    expect(requestSessionIdForEnvironment("device_buildbox", "desktop_two_abcdefgh")).not.toBe(first)
    expect(first).toMatch(/^request_[A-Za-z0-9_-]{24}$/)
  })
  it("persists a desktop request namespace across service restarts", async () => {
    const secrets = await Effect.runPromise(makeInMemorySecretStore())
    const first = await Effect.runPromise(
      makeRemoteSessionStateRepository(secrets).requestSessionId("device_buildbox")
    )
    const restored = await Effect.runPromise(
      makeRemoteSessionStateRepository(secrets).requestSessionId("device_buildbox")
    )
    const cleanInstall = await Effect.runPromise(
      makeRemoteSessionStateRepository(await Effect.runPromise(makeInMemorySecretStore()))
        .requestSessionId("device_buildbox")
    )
    expect(restored).toBe(first)
    expect(cleanInstall).not.toBe(first)
  })
  it("requests every replay page when more than 256 envelopes are pending", async () => {
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing relay address")
    const resumed = new Promise<number>((resolve) => {
      server.once("connection", (socket) => {
        socket.send(JSON.stringify({ type: "hello", nextSequence: 1, acknowledgedSequence: 0 }))
        socket.send(JSON.stringify({ type: "replay-more", sequence: 256 }))
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString("utf8"))
          if (message.type === "resume") resolve(message.acknowledgedSequence)
        })
      })
    })
    const tunnel = await Effect.runPromise(openRemoteTunnel({
      relayUrl: `http://127.0.0.1:${address.port}`,
      grant: "grant_replay_abcdefghijklmnop",
      sessionId: "session_replay_abcdefgh",
      endpoint: "desktop",
      acknowledgedSequence: 0
    }))
    await expect(resumed).resolves.toBe(256)
    await Effect.runPromise(tunnel.close)
  })
  it("coalesces cumulative acknowledgements before sending them to the relay", async () => {
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing relay address")
    const acknowledgements: number[] = []
    const received = new Promise<void>((resolve) => {
      server.once("connection", (socket) => {
        socket.send(JSON.stringify({ type: "hello", nextSequence: 1, acknowledgedSequence: 0 }))
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString("utf8"))
          if (message.type !== "ack") return
          acknowledgements.push(message.acknowledgement.acknowledgedSequence)
          resolve()
        })
      })
    })
    const tunnel = await Effect.runPromise(openRemoteTunnel({
      relayUrl: `http://127.0.0.1:${address.port}`,
      grant: "grant_ack_abcdefghijklmnop",
      sessionId: "session_ack_abcdefgh",
      endpoint: "desktop",
      acknowledgedSequence: 0
    }))

    await Effect.runPromise(Effect.all([
      tunnel.acknowledge(1),
      tunnel.acknowledge(2),
      tunnel.acknowledge(3)
    ]))
    await received
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(acknowledgements).toEqual([3])
    await Effect.runPromise(tunnel.close)
  })
  it("opens the shared tunnel protocol through BatchMode SSH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jingler-fake-ssh-"))
    temporaryDirectories.push(directory)
    const executable = join(directory, "ssh")
    await writeFile(executable, `#!/usr/bin/env node
process.stdin.setEncoding("utf8")
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n")
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.type === "direct-open") process.stdout.write(JSON.stringify({ type: "hello", nextSequence: 1, acknowledgedSequence: 0 }) + "\\n")
    if (message.type === "envelope") process.stdout.write(JSON.stringify({ type: "envelope-result", status: "inserted", sequence: message.envelope.sequence }) + "\\n")
  }
})
`, { mode: 0o700 })
    await chmod(executable, 0o700)
    const pair = generateKeyPairSync("x25519")
    const publicKey = pair.publicKey.export({ format: "jwk" })
    if (!publicKey.x) throw new Error("missing direct test key")
    const established = establishDesktopSessionKey({
      subject: "user-one",
      deviceId: "device_direct",
      sessionId: "session_direct",
      devicePublicKey: { algorithm: "X25519", encoding: "base64url", value: publicKey.x }
    })
    const tunnel = await Effect.runPromise(openSshRemoteTunnel({
      target: { host: "buildbox" },
      sessionId: "session_direct",
      acknowledgedSequence: 0,
      keyOffer: established.offer,
      clientInstanceId: "client_direct",
      attachmentGeneration: 1,
      controllerLeaseGeneration: 1,
      sshBinary: executable
    }))
    await expect(Effect.runPromise(tunnel.nextOutgoingSequence)).resolves.toBe(1)
    await expect(Effect.runPromise(tunnel.send(
      encryptRemotePayload(established.key, "session_direct", 1, "desktop", { ok: true })
    ))).resolves.toBeUndefined()
    await Effect.runPromise(tunnel.close)
  })
  it("restores key inputs sequences cursors and pending command after process restart", async () => {
    const secrets = await Effect.runPromise(makeInMemorySecretStore())
    const device = generateKeyPairSync("x25519"); const jwk = device.publicKey.export({ format: "jwk" }); if (!jwk.x) throw new Error("missing x")
    const established = establishDesktopSessionKey({ subject: "user", deviceId: "buildbox", sessionId: "session", devicePublicKey: { algorithm: "X25519", encoding: "base64url", value: jwk.x } })
    const command = { version: 1 as const, commandId: "command_1", sessionId: "session", operation: "run", payload: { prompt: "hi" } }
    const envelope = encryptRemotePayload(established.key, "session", 4, "desktop", command, 1)
    const state = {
      version: 1 as const, sessionId: "session", deviceId: "buildbox", subject: "user",
      devicePublicKey: { algorithm: "X25519" as const, encoding: "base64url" as const, value: jwk.x },
      offer: established.offer, ephemeralPrivateKey: established.privateKey,
      nextOutgoingSequence: 5, acknowledgedDeviceSequence: 7,
      pendingCommands: { [command.commandId]: { command, envelope } }
    }
    await Effect.runPromise(makeRemoteSessionStateRepository(secrets).put(state))
    const restored = await Effect.runPromise(makeRemoteSessionStateRepository(secrets).get("session"))
    expect(restored).toEqual(state)
    expect(restored?.pendingCommands[command.commandId]?.envelope).toEqual(envelope)
    await Effect.runPromise(makeRemoteSessionStateRepository(secrets).remove("session"))
    await expect(Effect.runPromise(makeRemoteSessionStateRepository(secrets).get("session"))).resolves.toBeNull()
  })
  it("evicts a closed socket refreshes its grant and resumes the pending command", async () => {
    const deviceKeys = generateKeyPairSync("x25519")
    const encryptionJwk = deviceKeys.publicKey.export({ format: "jwk" })
    if (!encryptionJwk.x) throw new Error("missing device encryption key")
    const deviceEncryptionPublicKey = encryptionJwk.x
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing relay address")
    const relayUrl = `http://127.0.0.1:${address.port}`
    const received: Array<{ readonly commandId: string; readonly ciphertext: string }> = []
    let connections = 0
    server.on("connection", (socket, request) => {
      connections += 1
      socket.send(JSON.stringify({ type: "hello", nextSequence: connections === 1 ? 1 : 2, acknowledgedSequence: 0 }))
      const url = new URL(request.url ?? "/", relayUrl)
      const encodedOffer = url.searchParams.get("keyOffer")
      if (!encodedOffer) throw new Error("missing key offer")
      const offer = JSON.parse(Buffer.from(encodedOffer, "base64url").toString("utf8"))
      const key = deriveDeviceSessionKey(
        offer,
        (remote) => new Uint8Array(diffieHellman({ privateKey: deviceKeys.privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: remote.value }, format: "jwk" }) })),
        { subject: "user_subject", deviceId: "device_buildbox", sessionId: "session_restart_abcdefgh" }
      )
      if (connections === 2) {
        const resumedCommandId = received[0]?.commandId
        if (!resumedCommandId) throw new Error("missing persisted command")
        const replayed: ReadonlyArray<RemoteSessionEvent> = [
          ...Array.from({ length: 64 }, (_, index): RemoteSessionEvent => ({
            version: 1, commandId: resumedCommandId, sessionId: "session_restart_abcdefgh",
            eventSequence: index + 1, kind: "event", payload: `chunk-${index + 1}`
          })),
          {
            version: 1, commandId: resumedCommandId, sessionId: "session_restart_abcdefgh",
            eventSequence: 65, kind: "complete", payload: "done"
          }
        ]
        replayed.forEach((event, index) => {
          socket.send(JSON.stringify({
            type: "envelope",
            envelope: encryptRemotePayload(
              key,
              "session_restart_abcdefgh",
              index + 1,
              "device",
              event,
              1
            )
          }))
        })
      }
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"))
        if (message.type !== "envelope") return
        const command = decryptRemotePayload(key, message.envelope, Schema.Struct({
          version: Schema.Literal(1), commandId: Schema.String, sessionId: Schema.String,
          operation: Schema.String, payload: Schema.Unknown
        }))
        received.push({ commandId: command.commandId, ciphertext: message.envelope.ciphertext })
        socket.send(JSON.stringify({ type: "envelope-result", status: "inserted", sequence: message.envelope.sequence }))
        if (connections === 1) {
          socket.close(1012, "restart")
          return
        }
      })
    })
    const secrets = await Effect.runPromise(makeInMemorySecretStore())
    let grants = 0
    const fakeDevice: RemoteDevice = {
      version: 1, deviceId: "device_buildbox", displayName: "buildbox",
      platform: { os: "darwin", arch: "arm64" },
      publicKey: { algorithm: "Ed25519", encoding: "base64url", value: "A".repeat(43) },
      encryptionPublicKey: { algorithm: "X25519", encoding: "base64url", value: deviceEncryptionPublicKey },
      capabilities: { version: 1, capabilities: ["session.start"], maxConcurrentSessions: 1 },
      state: "active", generation: 1, createdAt: 1, updatedAt: 1,
      presence: { version: 1, state: "online", connectedAt: 1, lastSeenAt: 1, activeSessionIds: [] }
    }
    const environment = {
      _tag: "@jingler/EnvironmentService" as const,
      list: Effect.succeed([]),
      environment: () => Effect.succeed(environmentFromRemoteDevice(fakeDevice)),
      kind: () => Effect.succeed("owned" as const),
      refresh: Effect.succeed([]),
      suggestHosts: () => Effect.succeed([]),
      device: () => Effect.succeed(fakeDevice),
      sessionGrant: () => {
        grants += 1
        const response: DeviceRelayGrantResponse = {
          version: 1, relayUrl, grant: `grant_${grants}_abcdefghijklmnop`,
          claims: { version: 1, issuer: "jingler", audience: "session-tunnel",
            subject: "user_subject", deviceId: "device_buildbox", sessionId: "session_restart_abcdefgh",
            clientInstanceId: "client_abcdefghijklmnop", attachmentGeneration: 1,
            controllerLeaseGeneration: 1,
            deviceGeneration: 1, issuedAt: 1, expiresAt: 9999999999, grantId: `grant_${grants}_abcdefghijklmnop` }
        }
        return Effect.succeed(response)
      },
      managedSessionGrant: () => Effect.never,
      discovery: () => Effect.never,
      directSsh: () => Effect.succeed(null),
      pairSsh: () => Effect.never,
      hydrateManagedWorkspace: () => Effect.never,
      cleanupManagedSession: () => Effect.void,
      rename: () => Effect.never,
      revoke: () => Effect.never
    }
    const services = RemoteSessionService.Default.pipe(
      Layer.provide(Layer.mergeAll(
        Layer.succeed(EnvironmentService, environment),
        Layer.succeed(SecretStore, secrets)
      ))
    )
    const events = await Effect.runPromise(Effect.gen(function* () {
      const remote = yield* RemoteSessionService
      return yield* remote.execute(
        { id: "session_restart_abcdefgh", environmentId: "device_buildbox" },
        "run",
        { prompt: "hello" }
      ).pipe(Stream.runCollect)
    }).pipe(Effect.provide(services)))
    expect(Chunk.toReadonlyArray(events)).toEqual([
      ...Array.from({ length: 64 }, (_, index): RemoteSessionEvent => ({
        version: 1, commandId: received[0]?.commandId ?? "missing-command",
        sessionId: "session_restart_abcdefgh", eventSequence: index + 1,
        kind: "event", payload: `chunk-${index + 1}`
      })),
      {
        version: 1, commandId: received[0]?.commandId,
        sessionId: "session_restart_abcdefgh", eventSequence: 65,
        kind: "complete", payload: "done"
      }
    ])
    expect(connections).toBe(2)
    expect(grants).toBe(2)
    expect(received).toHaveLength(1)
  })

  it("dispatches a stop command while a run command is still in flight", async () => {
    const deviceKeys = generateKeyPairSync("x25519")
    const encryptionJwk = deviceKeys.publicKey.export({ format: "jwk" })
    if (!encryptionJwk.x) throw new Error("missing device encryption key")
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing relay address")
    const relayUrl = `http://127.0.0.1:${address.port}`
    const operations: string[] = []
    server.on("connection", (socket, request) => {
      socket.send(JSON.stringify({ type: "hello", nextSequence: 1, acknowledgedSequence: 0 }))
      const url = new URL(request.url ?? "/", relayUrl)
      const encodedOffer = url.searchParams.get("keyOffer")
      if (!encodedOffer) throw new Error("missing key offer")
      const offer = JSON.parse(Buffer.from(encodedOffer, "base64url").toString("utf8"))
      const key = deriveDeviceSessionKey(offer, (remote) => new Uint8Array(diffieHellman({
        privateKey: deviceKeys.privateKey,
        publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: remote.value }, format: "jwk" })
      })), { subject: "user_subject", deviceId: "device_buildbox", sessionId: "session_concurrent_abcdefgh" })
      let runCommandId: string | undefined
      let eventSequence = 0
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"))
        if (message.type !== "envelope") return
        const command = decryptRemotePayload(key, message.envelope, Schema.Struct({
          version: Schema.Literal(1), commandId: Schema.String, sessionId: Schema.String,
          operation: Schema.String, payload: Schema.Unknown
        }))
        operations.push(command.operation)
        socket.send(JSON.stringify({ type: "envelope-result", status: "inserted", sequence: message.envelope.sequence }))
        if (command.operation === "Agent.run") {
          runCommandId = command.commandId
          return
        }
        if (command.operation === "Agent.stop" && runCommandId) {
          for (const [commandId, payload] of [[command.commandId, "stopped"], [runCommandId, "run-finished"]] as const) {
            eventSequence += 1
            socket.send(JSON.stringify({
              type: "envelope",
              envelope: encryptRemotePayload(key, "session_concurrent_abcdefgh", eventSequence, "device", {
                version: 1, commandId, sessionId: "session_concurrent_abcdefgh",
                eventSequence: 1, kind: "complete", payload
              }, 1)
            }))
          }
        }
      })
    })
    const secrets = await Effect.runPromise(makeInMemorySecretStore())
    const fakeDevice: RemoteDevice = {
      version: 1, deviceId: "device_buildbox", displayName: "buildbox",
      platform: { os: "darwin", arch: "arm64" },
      publicKey: { algorithm: "Ed25519", encoding: "base64url", value: "A".repeat(43) },
      encryptionPublicKey: { algorithm: "X25519", encoding: "base64url", value: encryptionJwk.x },
      capabilities: { version: 1, capabilities: ["session.start"], maxConcurrentSessions: 1 },
      state: "active", generation: 1, createdAt: 1, updatedAt: 1,
      presence: { version: 1, state: "online", connectedAt: 1, lastSeenAt: 1, activeSessionIds: [] }
    }
    const environment = {
      _tag: "@jingler/EnvironmentService" as const,
      list: Effect.succeed([]), refresh: Effect.succeed([]), suggestHosts: () => Effect.succeed([]),
      environment: () => Effect.succeed(environmentFromRemoteDevice(fakeDevice)),
      kind: () => Effect.succeed("owned" as const),
      device: () => Effect.succeed(fakeDevice),
      sessionGrant: (_deviceId: string, sessionId: string) => Effect.succeed({
        version: 1 as const, relayUrl, grant: "grant_concurrent_abcdefghijklmnop",
        claims: { version: 1 as const, issuer: "jingler" as const, audience: "session-tunnel" as const,
          subject: "user_subject", deviceId: "device_buildbox", sessionId,
          clientInstanceId: "client_abcdefghijklmnop", attachmentGeneration: 1,
          controllerLeaseGeneration: 1,
          deviceGeneration: 1, issuedAt: 1, expiresAt: 9999999999, grantId: "grant_concurrent_abcdefghijklmnop" }
      }),
      managedSessionGrant: () => Effect.never,
      discovery: () => Effect.never, directSsh: () => Effect.succeed(null), pairSsh: () => Effect.never,
      hydrateManagedWorkspace: () => Effect.never,
      cleanupManagedSession: () => Effect.void,
      rename: () => Effect.never, revoke: () => Effect.never
    }
    const services = RemoteSessionService.Default.pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(EnvironmentService, environment), Layer.succeed(SecretStore, secrets)
    )))
    const result = await Effect.runPromise(Effect.gen(function* () {
      const remote = yield* RemoteSessionService
      const session = { id: "session_concurrent_abcdefgh", environmentId: "device_buildbox" }
      const run = yield* Effect.fork(remote.request(session, "Agent.run", { prompt: "hello" }))
      yield* Effect.sleep(10)
      const stopped = yield* remote.request(session, "Agent.stop", null)
      const finished = yield* Fiber.join(run)
      return { stopped, finished }
    }).pipe(Effect.provide(services)))
    expect(result).toEqual({ stopped: "stopped", finished: "run-finished" })
    expect(operations).toEqual(["Agent.run", "Agent.stop"])
  })
})
