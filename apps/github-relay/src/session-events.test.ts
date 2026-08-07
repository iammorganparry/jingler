import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { retainedCursorFloor } from "./session-events.js"
import { normalizedEvent } from "./test-support.js"

const connect = async (relaySessionId: string, clientId: string, cursor = 0) => {
  const response = await env.SESSION_EVENTS.getByName(relaySessionId).fetch(
    new Request("https://relay.internal/events", {
      headers: {
        Upgrade: "websocket",
        "x-jingler-client-id": clientId,
        "x-jingler-cursor": String(cursor),
        "x-jingler-expires-at": String(Date.now() + 300_000)
      }
    })
  )
  expect(response.status).toBe(101)
  return response.webSocket!
}

const messages = (
  socket: WebSocket,
  count: number
): Promise<readonly Record<string, unknown>[]> =>
  new Promise((resolve, reject) => {
    const received: Record<string, unknown>[] = []
    const timer = setTimeout(() => reject(new Error("Timed out waiting for relay messages")), 2_000)
    socket.addEventListener("message", (message) => {
      received.push(JSON.parse(String(message.data)) as Record<string, unknown>)
      if (received.length !== count) return
      clearTimeout(timer)
      resolve(received)
    })
  })

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> =>
  messages(socket, 1).then(([message]) => message!)

describe("session event persistence", () => {
  it("computes the retention floor from the indexed cursor without counting the event log", () => {
    expect(retainedCursorFloor(4_999, 5_000)).toBe(0)
    expect(retainedCursorFloor(5_000, 5_000)).toBe(0)
    expect(retainedCursorFloor(5_001, 5_000)).toBe(1)
    expect(retainedCursorFloor(12_345, 5_000)).toBe(7_345)
  })

  it("uses a distinct event log and cursor stream for every relay session id", async () => {
    const first = env.SESSION_EVENTS.getByName("relay-session-isolation-a")
    const second = env.SESSION_EVENTS.getByName("relay-session-isolation-b")
    await first.publish(normalizedEvent({ deliveryId: "session-a-delivery", semanticKey: "a" }))
    await second.publish(normalizedEvent({ deliveryId: "session-b-delivery", semanticKey: "b" }))

    await expect(first.eventCount()).resolves.toBe(1)
    await expect(second.eventCount()).resolves.toBe(1)
  })

  it("deduplicates a retried delivery and a semantically unchanged edit", async () => {
    const stream = env.SESSION_EVENTS.getByName("relay-session-deduplication")
    await expect(stream.publish(normalizedEvent())).resolves.toMatchObject({ inserted: true })
    await expect(stream.publish(normalizedEvent())).resolves.toEqual({ inserted: false, cursor: null })
    await expect(
      stream.publish(normalizedEvent({ deliveryId: "delivery-edited" }))
    ).resolves.toEqual({ inserted: false, cursor: null })
    await expect(stream.eventCount()).resolves.toBe(1)
  })

  it("deletes retained events when a session route is permanently removed", async () => {
    const stream = env.SESSION_EVENTS.getByName("relay-session-retired")
    await stream.publish(normalizedEvent({ deliveryId: "retired", semanticKey: "retired" }))
    await expect(stream.eventCount()).resolves.toBe(1)
    await expect(stream.retire()).resolves.toBe(0)
    await expect(stream.eventCount()).resolves.toBe(0)
  })

  it("replays only unacknowledged session events after an offline reconnect", async () => {
    const relaySessionId = "relay-session-offline-replay"
    const stream = env.SESSION_EVENTS.getByName(relaySessionId)
    await stream.publish(normalizedEvent({ deliveryId: "offline-1", semanticKey: "offline-1" }))

    const firstSocket = await connect(relaySessionId, "desktop-replay")
    const firstMessages = messages(firstSocket, 2)
    firstSocket.accept()
    await expect(firstMessages).resolves.toMatchObject([
      { type: "hello", cursor: 0, newestCursor: 1 },
      { type: "event", cursor: 1, event: { deliveryId: "offline-1" } }
    ])
    firstSocket.send(JSON.stringify({ type: "ack", cursor: 1 }))
    const pong = nextMessage(firstSocket)
    firstSocket.send(JSON.stringify({ type: "ping" }))
    await expect(pong).resolves.toMatchObject({ type: "pong" })
    firstSocket.close(1000, "offline")

    await stream.publish(normalizedEvent({ deliveryId: "offline-2", semanticKey: "offline-2" }))
    const secondSocket = await connect(relaySessionId, "desktop-replay", 0)
    const replayed = messages(secondSocket, 2)
    secondSocket.accept()
    await expect(replayed).resolves.toMatchObject([
      { type: "hello", cursor: 1, newestCursor: 2 },
      { type: "event", cursor: 2, event: { deliveryId: "offline-2" } }
    ])
    secondSocket.close(1000, "done")
  })
})
