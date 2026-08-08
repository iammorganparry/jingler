import type { EncryptedTunnelEnvelope, TunnelEndpoint } from "@jingler/core"
import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { type SessionTunnelObject, TUNNEL_POLICY } from "./session-tunnel.js"

const nowSeconds = Math.floor(Date.now() / 1_000)

const initialization = (sessionId: string) => ({
  sessionId,
  subject: "user-one",
  deviceId: "device_abcdefghijklmnop",
  deviceGeneration: 1,
  expiresAt: nowSeconds + 600
})

const envelope = (
  sessionId: string,
  sender: TunnelEndpoint,
  sequence: number,
  ciphertext = `ciphertext_${sequence}`
): EncryptedTunnelEnvelope => ({
  version: 1,
  sessionId,
  sender,
  sequence,
  algorithm: "AES-256-GCM",
  nonce: "A".repeat(16),
  ciphertext,
  createdAt: nowSeconds
})

const messages = (
  socket: WebSocket,
  count: number
): Promise<readonly Record<string, unknown>[]> =>
  new Promise((resolve, reject) => {
    const received: Record<string, unknown>[] = []
    const timer = setTimeout(() => reject(new Error("Timed out waiting for tunnel messages")), 3_000)
    socket.addEventListener("message", (message) => {
      const parsed: Record<string, unknown> = JSON.parse(String(message.data))
      received.push(parsed)
      if (received.length !== count) return
      clearTimeout(timer)
      resolve(received)
    })
  })

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> =>
  messages(socket, 1).then(([message]) => message!)

const connect = async (
  tunnel: DurableObjectStub<SessionTunnelObject>,
  input: ReturnType<typeof initialization>,
  endpoint: TunnelEndpoint,
  acknowledgedSequence = 0
): Promise<WebSocket> => {
  const response = await tunnel.fetch(
    new Request("https://relay.internal/tunnel", {
      headers: {
        Upgrade: "websocket",
        "x-jingler-endpoint": endpoint,
        "x-jingler-session-id": input.sessionId,
        "x-jingler-subject": input.subject,
        "x-jingler-device-id": input.deviceId,
        "x-jingler-device-generation": String(input.deviceGeneration),
        "x-jingler-expires-at": String(input.expiresAt),
        "x-jingler-acknowledged-sequence": String(acknowledgedSequence)
      }
    })
  )
  expect(response.status).toBe(101)
  return response.webSocket!
}

describe("encrypted session tunnel", () => {
  it("replays unacknowledged envelopes after reconnect", async () => {
    const input = initialization("session_replay_abcdefghijkl")
    const tunnel = env.SESSION_TUNNEL.getByName(input.sessionId)
    await expect(tunnel.initialize(input, nowSeconds)).resolves.toBe(true)
    const desktop = await connect(tunnel, input, "desktop")
    const device = await connect(tunnel, input, "device")
    desktop.accept()
    device.accept()
    await expect(nextMessage(desktop)).resolves.toMatchObject({ type: "hello", endpoint: "desktop" })
    await expect(nextMessage(device)).resolves.toMatchObject({ type: "hello", endpoint: "device" })

    const firstDelivery = nextMessage(device)
    const firstAccepted = nextMessage(desktop)
    desktop.send(JSON.stringify({ type: "envelope", envelope: envelope(input.sessionId, "desktop", 1) }))
    await expect(firstDelivery).resolves.toMatchObject({
      type: "envelope",
      envelope: { sequence: 1, ciphertext: "ciphertext_1" }
    })
    await expect(firstAccepted).resolves.toMatchObject({ type: "envelope-result", status: "inserted" })

    const secondDelivery = nextMessage(device)
    const secondAccepted = nextMessage(desktop)
    desktop.send(JSON.stringify({ type: "envelope", envelope: envelope(input.sessionId, "desktop", 2) }))
    await expect(secondDelivery).resolves.toMatchObject({ type: "envelope", envelope: { sequence: 2 } })
    await expect(secondAccepted).resolves.toMatchObject({ type: "envelope-result", status: "inserted" })

    const acknowledged = nextMessage(device)
    const peerAcknowledged = nextMessage(desktop)
    device.send(
      JSON.stringify({
        type: "ack",
        acknowledgement: {
          version: 1,
          sessionId: input.sessionId,
          sender: "device",
          acknowledgedSequence: 1
        }
      })
    )
    await expect(acknowledged).resolves.toMatchObject({ type: "acknowledged", sequence: 1 })
    await expect(peerAcknowledged).resolves.toMatchObject({ type: "peer-acknowledged", sequence: 1 })
    await expect(tunnel.storedSequences("desktop")).resolves.toEqual([2])

    const fullyAcknowledged = nextMessage(device)
    device.send(
      JSON.stringify({
        type: "ack",
        acknowledgement: {
          version: 1,
          sessionId: input.sessionId,
          sender: "device",
          acknowledgedSequence: 2
        }
      })
    )
    await expect(fullyAcknowledged).resolves.toMatchObject({
      type: "acknowledged",
      sequence: 2
    })
    await expect(tunnel.storedSequences("desktop")).resolves.toEqual([])

    const thirdDelivery = nextMessage(device)
    const thirdAccepted = nextMessage(desktop)
    desktop.send(
      JSON.stringify({ type: "envelope", envelope: envelope(input.sessionId, "desktop", 3) })
    )
    await expect(thirdDelivery).resolves.toMatchObject({
      type: "envelope",
      envelope: { sequence: 3 }
    })
    await expect(thirdAccepted).resolves.toMatchObject({
      type: "envelope-result",
      status: "inserted"
    })

    device.close(1000, "reconnect")
    const reconnected = await connect(tunnel, input, "device")
    const replay = messages(reconnected, 2)
    reconnected.accept()
    await expect(replay).resolves.toMatchObject([
      { type: "hello", endpoint: "device", acknowledgedSequence: 2 },
      { type: "envelope", envelope: { sequence: 3, ciphertext: "ciphertext_3" } }
    ])
    desktop.close(1000, "done")
    reconnected.close(1000, "done")
  })

  it("does not replay acknowledged commands", async () => {
    const input = initialization("session_acknowledged_abcdefgh")
    const tunnel = env.SESSION_TUNNEL.getByName(input.sessionId)
    await tunnel.initialize(input, nowSeconds)
    const desktop = await connect(tunnel, input, "desktop")
    const device = await connect(tunnel, input, "device")
    desktop.accept()
    device.accept()
    await nextMessage(desktop)
    await nextMessage(device)

    const delivery = nextMessage(device)
    const accepted = nextMessage(desktop)
    desktop.send(
      JSON.stringify({ type: "envelope", envelope: envelope(input.sessionId, "desktop", 1) })
    )
    await expect(delivery).resolves.toMatchObject({
      type: "envelope",
      envelope: { sequence: 1 }
    })
    await expect(accepted).resolves.toMatchObject({ type: "envelope-result", status: "inserted" })

    const acknowledged = nextMessage(device)
    device.send(
      JSON.stringify({
        type: "ack",
        acknowledgement: {
          version: 1,
          sessionId: input.sessionId,
          sender: "device",
          acknowledgedSequence: 1
        }
      })
    )
    await expect(acknowledged).resolves.toMatchObject({ type: "acknowledged", sequence: 1 })
    await expect(tunnel.storedSequences("desktop")).resolves.toEqual([])

    device.close(1000, "reconnect")
    const reconnected = await connect(tunnel, input, "device")
    reconnected.accept()
    await expect(nextMessage(reconnected)).resolves.toMatchObject({
      type: "hello",
      acknowledgedSequence: 1
    })
    await expect(tunnel.storedSequences("desktop")).resolves.toEqual([])
    desktop.close(1000, "done")
    reconnected.close(1000, "done")
  })

  it("keeps sender sequences stable across duplicate delivery and rejects gaps or conflicts", async () => {
    const input = initialization("session_sequences_abcdefghijk")
    const tunnel = env.SESSION_TUNNEL.getByName(input.sessionId)
    await tunnel.initialize(input, nowSeconds)
    const first = envelope(input.sessionId, "desktop", 1)
    await expect(tunnel.publishEnvelope("desktop", first)).resolves.toEqual({
      status: "inserted",
      sequence: 1
    })
    await expect(tunnel.publishEnvelope("desktop", first)).resolves.toEqual({
      status: "duplicate",
      sequence: 1
    })
    await expect(
      tunnel.publishEnvelope("desktop", { ...first, ciphertext: "different" })
    ).resolves.toEqual({ status: "sequence-conflict", sequence: 1 })
    await expect(
      tunnel.publishEnvelope("desktop", envelope(input.sessionId, "desktop", 3))
    ).resolves.toEqual({ status: "sequence-gap", expectedSequence: 2 })
    await expect(tunnel.storedSequences("desktop")).resolves.toEqual([1])

    const retainedInput = initialization("session_pruned_cursor_abcdefgh")
    const retainedTunnel = env.SESSION_TUNNEL.getByName(retainedInput.sessionId)
    await retainedTunnel.initialize(retainedInput, nowSeconds)
    await expect(
      retainedTunnel.publishEnvelope(
        "desktop",
        envelope(retainedInput.sessionId, "desktop", 1)
      )
    ).resolves.toMatchObject({ status: "inserted", sequence: 1 })
    await runInDurableObject(retainedTunnel, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE encrypted_envelopes SET created_at = ?",
        Math.floor(Date.now() / 1_000) - TUNNEL_POLICY.retentionSeconds
      )
      await instance.alarm()
    })
    await expect(retainedTunnel.storedSequences("desktop")).resolves.toEqual([])
    await expect(
      retainedTunnel.publishEnvelope(
        "desktop",
        envelope(retainedInput.sessionId, "desktop", 2)
      )
    ).resolves.toMatchObject({ status: "inserted", sequence: 2 })
  })

  it("reports a bounded replay gap when retention is exceeded", async () => {
    const input = initialization("session_bounded_abcdefghijklm")
    const tunnel = env.SESSION_TUNNEL.getByName(input.sessionId)
    await tunnel.initialize(input, nowSeconds)
    for (let sequence = 1; sequence <= TUNNEL_POLICY.maxStoredEnvelopes + 2; sequence += 1) {
      const result = await tunnel.publishEnvelope(
        "desktop",
        envelope(input.sessionId, "desktop", sequence)
      )
      expect(result.status).toBe("inserted")
    }
    await expect(tunnel.envelopeCount()).resolves.toBe(TUNNEL_POLICY.maxStoredEnvelopes)
    const stored = await tunnel.storedSequences("desktop")
    expect(stored[0]).toBe(3)

    const device = await connect(tunnel, input, "device")
    const replay = messages(device, TUNNEL_POLICY.maxReplayEnvelopes + 3)
    device.accept()
    const received = await replay
    expect(received[0]).toMatchObject({ type: "hello" })
    expect(received[1]).toMatchObject({
      type: "replay-truncated",
      acknowledgedSequence: 0,
      oldestSequence: 3
    })
    expect(received[2]).toMatchObject({ type: "envelope", envelope: { sequence: 3 } })
    expect(received.at(-1)).toMatchObject({ type: "replay-more" })
    device.close(1000, "done")
  })

  it("persists only validated encrypted envelopes", async () => {
    const input = initialization("session_ciphertext_abcdefghij")
    const tunnel = env.SESSION_TUNNEL.getByName(input.sessionId)
    await tunnel.initialize(input, nowSeconds)
    const badEnvelope = { ...envelope(input.sessionId, "desktop", 1), prompt: "do not store me" }
    await expect(tunnel.publishEnvelope("desktop", badEnvelope)).resolves.toEqual({
      status: "invalid-envelope"
    })
    await tunnel.publishEnvelope("desktop", envelope(input.sessionId, "desktop", 1))
    await runInDurableObject(tunnel, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ readonly [key: string]: SqlStorageValue; readonly payload: string }>(
          "SELECT payload FROM encrypted_envelopes"
        )
        .one()
      expect(row.payload).toContain("ciphertext_1")
      expect(row.payload).not.toContain("prompt")
      expect(row.payload).not.toContain("do not store me")
    })
  })

  it("closes both session endpoints when the owning device is revoked", async () => {
    const input = initialization("session_revocation_abcdefghij")
    const tunnel = env.SESSION_TUNNEL.getByName(input.sessionId)
    await tunnel.initialize(input, nowSeconds)
    const desktop = await connect(tunnel, input, "desktop")
    const device = await connect(tunnel, input, "device")
    desktop.accept()
    device.accept()
    await nextMessage(desktop)
    await nextMessage(device)
    const desktopClosed = new Promise<CloseEvent>((resolve) =>
      desktop.addEventListener("close", (event) => resolve(event))
    )
    const deviceClosed = new Promise<CloseEvent>((resolve) =>
      device.addEventListener("close", (event) => resolve(event))
    )
    await expect(tunnel.revokeDevice(input.deviceId, 2, nowSeconds + 1)).resolves.toBe(2)
    await expect(desktopClosed).resolves.toMatchObject({ code: 4003, reason: "Device revoked" })
    await expect(deviceClosed).resolves.toMatchObject({ code: 4003, reason: "Device revoked" })
    await expect(tunnel.initialize(input, nowSeconds + 2)).resolves.toBe(false)
  })

  it("rejects a socket whose resource scope does not match initialized metadata", async () => {
    const input = initialization("session_scope_abcdefghijklmn")
    const tunnel = env.SESSION_TUNNEL.getByName(input.sessionId)
    await tunnel.initialize(input, nowSeconds)
    const response = await tunnel.fetch(
      new Request("https://relay.internal/tunnel", {
        headers: {
          Upgrade: "websocket",
          "x-jingler-endpoint": "desktop",
          "x-jingler-session-id": "session_other_abcdefghijkl",
          "x-jingler-subject": input.subject,
          "x-jingler-device-id": input.deviceId,
          "x-jingler-device-generation": "1",
          "x-jingler-expires-at": String(input.expiresAt)
        }
      })
    )
    expect(response.status).toBe(403)
  })
})
