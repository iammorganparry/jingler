import { env, runInDurableObject, SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { githubPayload, hmacHex, issueTestRelayGrant, normalizedEvent } from "./test-support.js"
import type { UserEventsObject } from "./user-events.js"

interface EventCountRow {
  readonly [key: string]: SqlStorageValue
  readonly count: number
}

const storedEventCount = async (userId: string): Promise<number> => {
  const stub = env.USER_EVENTS.getByName(userId)
  return runInDurableObject(stub, async (_instance: UserEventsObject, state) => {
    const row = state.storage.sql.exec<EventCountRow>("SELECT COUNT(*) AS count FROM events").one()
    return row.count
  })
}

const signedWebhook = async (
  deliveryId: string,
  payload: unknown = githubPayload(),
  eventName = "issue_comment"
): Promise<Response> => {
  const body = JSON.stringify(payload)
  return SELF.fetch("https://relay.test/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": eventName,
      "x-hub-signature-256": `sha256=${await hmacHex(body, "test-webhook-secret")}`
    },
    body
  })
}

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket message")), 2_000)
    socket.addEventListener(
      "message",
      (message) => {
        clearTimeout(timer)
        resolve(JSON.parse(String(message.data)) as Record<string, unknown>)
      },
      { once: true }
    )
  })

const nextClose = (socket: WebSocket): Promise<{ readonly code: number; readonly reason: string }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket close")), 4_000)
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer)
        resolve({ code: event.code, reason: event.reason })
      },
      { once: true }
    )
  })

const connectSocket = async (grant: string, clientId: string): Promise<WebSocket> => {
  const response = await SELF.fetch(
    `https://relay.test/events?clientId=${encodeURIComponent(clientId)}&cursor=0`,
    { headers: { Upgrade: "websocket", Authorization: `Bearer ${grant}` } }
  )
  expect(response.status).toBe(101)
  const socket = response.webSocket!
  const hello = nextMessage(socket)
  socket.accept()
  await expect(hello).resolves.toMatchObject({ type: "hello" })
  return socket
}

const revokeInternally = async (userId: string, installationId: string): Promise<Response> => {
  const body = JSON.stringify({ userId, installationId, reason: "disconnect" })
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const signature = await hmacHex(`${timestamp}.${body}`, "test-relay-signing-secret")
  return SELF.fetch("https://relay.test/internal/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jingler-timestamp": timestamp,
      "x-jingler-signature": `sha256=${signature}`
    },
    body
  })
}

describe("GitHub relay HTTP boundary", () => {
  it("exposes only the fixed health, webhook, and event paths", async () => {
    const health = await SELF.fetch("https://relay.test/health")
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      service: "@jingler/github-relay"
    })
    expect((await SELF.fetch("https://relay.test/webhooks/github")).status).toBe(404)
    expect(
      (await SELF.fetch("https://relay.test/webhooks/github/", { method: "POST" })).status
    ).toBe(404)
  })

  it("rejects unverified webhook bytes before parsing", async () => {
    const response = await SELF.fetch("https://relay.test/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-invalid",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": "sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      body: "not-json"
    })
    expect(response.status).toBe(401)
  })

  it("rejects unsigned internal revocation requests", async () => {
    const response = await SELF.fetch("https://relay.test/internal/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-a", installationId: "99" })
    })
    expect(response.status).toBe(401)
  })

  it("acknowledges duplicate delivery ids without duplicate persistence", async () => {
    const installation = env.INSTALLATION_ROUTES.getByName("99")
    await installation.subscribe("user-deduplicated", Date.now() + 60_000)
    const first = await signedWebhook("delivery-deduplicated")
    const duplicate = await signedWebhook("delivery-deduplicated")
    expect(first.status).toBe(200)
    expect(duplicate.status).toBe(200)
    await expect(duplicate.json()).resolves.toMatchObject({ duplicate: true, routedUsers: 0 })
    await expect(storedEventCount("user-deduplicated")).resolves.toBe(1)
  })
})

describe("installation routing and user isolation", () => {
  it("fans one shared installation out to every subscribed user and no unrelated user", async () => {
    const installation = env.INSTALLATION_ROUTES.getByName("shared-installation")
    await installation.subscribe("user-a", Date.now() + 60_000)
    await installation.subscribe("user-b", Date.now() + 60_000)
    await env.INSTALLATION_ROUTES.getByName("other-installation").subscribe(
      "user-c",
      Date.now() + 60_000
    )

    await expect(
      installation.dispatch(
        normalizedEvent({ installationId: "shared-installation", deliveryId: "shared-delivery" })
      )
    ).resolves.toEqual({ duplicate: false, routedUsers: 2 })
    await expect(storedEventCount("user-a")).resolves.toBe(1)
    await expect(storedEventCount("user-b")).resolves.toBe(1)
    await expect(storedEventCount("user-c")).resolves.toBe(0)
  })

  it("expires individual subscriptions without overwriting the remaining set", async () => {
    const installation = env.INSTALLATION_ROUTES.getByName("expiring-installation")
    await installation.subscribe("expired-user", Date.now() - 1)
    await installation.subscribe("active-user", Date.now() + 60_000)
    await expect(
      installation.dispatch(
        normalizedEvent({ installationId: "expiring-installation", deliveryId: "expiry-delivery" })
      )
    ).resolves.toEqual({ duplicate: false, routedUsers: 1 })
    await expect(storedEventCount("expired-user")).resolves.toBe(0)
    await expect(storedEventCount("active-user")).resolves.toBe(1)
  })

  it("deduplicates semantically unchanged feedback with distinct GitHub deliveries", async () => {
    const stream = env.USER_EVENTS.getByName("semantic-user")
    await expect(stream.publish(normalizedEvent())).resolves.toMatchObject({ inserted: true })
    await expect(
      stream.publish(normalizedEvent({ deliveryId: "delivery-edited" }))
    ).resolves.toEqual({ inserted: false, cursor: null })
    await expect(storedEventCount("semantic-user")).resolves.toBe(1)
  })
})

describe("hibernating websocket replay", () => {
  it("registers the grant subject, streams an event, and persists its client acknowledgement", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const grant = await issueTestRelayGrant({ issuedAt: now, expiresAt: now + 300 })
    const response = await SELF.fetch("https://relay.test/events?clientId=desktop-1&cursor=0", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${grant}` }
    })
    expect(response.status).toBe(101)
    const socket = response.webSocket
    expect(socket).not.toBeNull()
    socket?.accept()
    await expect(nextMessage(socket!)).resolves.toMatchObject({ type: "hello", cursor: 0 })

    const eventPromise = nextMessage(socket!)
    const webhook = await signedWebhook("delivery-live")
    expect(webhook.status).toBe(200)
    const delivered = await eventPromise
    expect(delivered).toMatchObject({ type: "event", cursor: 1 })
    socket?.send(JSON.stringify({ type: "ack", cursor: 1 }))
    socket?.close(1000, "reconnect")

    const reconnect = await SELF.fetch("https://relay.test/events?clientId=desktop-1&cursor=0", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${grant}` }
    })
    const reconnectSocket = reconnect.webSocket
    reconnectSocket?.accept()
    await expect(nextMessage(reconnectSocket!)).resolves.toMatchObject({
      type: "hello",
      cursor: 1,
      newestCursor: 1
    })
    reconnectSocket?.close(1000, "done")
  })

  it("closes at grant expiry and only reconnects with a fresh grant", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const expiring = await issueTestRelayGrant({
      grantId: "expiring",
      issuedAt: now,
      expiresAt: now + 1
    })
    const socket = await connectSocket(expiring, "desktop-expiry")
    await expect(nextClose(socket)).resolves.toMatchObject({
      code: 4001,
      reason: "Relay grant expired"
    })
    expect(
      (
        await SELF.fetch("https://relay.test/events?clientId=desktop-expiry&cursor=0", {
          headers: { Upgrade: "websocket", Authorization: `Bearer ${expiring}` }
        })
      ).status
    ).toBe(401)

    const fresh = await issueTestRelayGrant({
      grantId: "fresh",
      issuedAt: Math.floor(Date.now() / 1_000),
      expiresAt: Math.floor(Date.now() / 1_000) + 300
    })
    const reconnected = await connectSocket(fresh, "desktop-expiry")
    reconnected.close(1000, "done")
  })

  it("revokes one user and installation immediately without crossing users", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const socketA = await connectSocket(
      await issueTestRelayGrant({
        subject: "revoked-user",
        installationId: "99",
        issuedAt: now,
        expiresAt: now + 300
      }),
      "desktop-revoked"
    )
    const socketB = await connectSocket(
      await issueTestRelayGrant({
        subject: "other-user",
        installationId: "99",
        issuedAt: now,
        expiresAt: now + 300
      }),
      "desktop-other"
    )
    const closed = nextClose(socketA)
    const response = await revokeInternally("revoked-user", "99")
    expect(response.status).toBe(200)
    await expect(closed).resolves.toMatchObject({ code: 4003 })

    const delivered = nextMessage(socketB)
    expect((await signedWebhook("delivery-after-revoke")).status).toBe(200)
    await expect(delivered).resolves.toMatchObject({
      type: "event",
      event: { deliveryId: "delivery-after-revoke" }
    })
    await expect(storedEventCount("revoked-user")).resolves.toBe(0)
    socketB.close(1000, "done")
  })

  it.each(["suspend", "deleted"])(
    "reconciles installation %s lifecycle webhooks by closing every affected socket",
    async (action) => {
      const now = Math.floor(Date.now() / 1_000)
      const socket = await connectSocket(
        await issueTestRelayGrant({
          subject: `lifecycle-${action}`,
          installationId: "99",
          issuedAt: now,
          expiresAt: now + 300
        }),
        `desktop-${action}`
      )
      const closed = nextClose(socket)
      const response = await signedWebhook(
        `lifecycle-delivery-${action}`,
        githubPayload({ action, installation: { id: 99 } }),
        "installation"
      )
      expect(response.status).toBe(200)
      await expect(closed).resolves.toMatchObject({ code: 4003 })
    }
  )
})
