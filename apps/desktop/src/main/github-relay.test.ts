import { describe, expect, it, vi } from "vitest"
import type { GitHubRelayEvent } from "../../../../packages/cli-adapters/src/github-events.js"
import {
  GitHubRelayConnection,
  type GitHubRelaySocket,
  type GitHubRelaySocketRequest
} from "./github-relay.js"

class FakeSocket implements GitHubRelaySocket {
  readyState = 0
  readonly sent: string[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []
  private readonly listeners = new Map<
    string,
    Array<(event: { readonly data?: unknown; readonly code?: number; readonly reason?: string }) => void>
  >()

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { readonly data?: unknown; readonly code?: number; readonly reason?: string }) => void
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(value: string): void {
    this.sent.push(value)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.emit("open")
  }

  message(value: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(value) })
    }
  }

  closed(): void {
    this.readyState = 3
    this.emit("close")
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({})
  }
}

const event = (): GitHubRelayEvent => ({
  version: 1,
  deliveryId: "delivery-1",
  semanticKey: "semantic-1",
  event: "pull_request_review",
  action: "submitted",
  installationId: "99",
  repository: { id: "200", owner: "acme", name: "widget", fullName: "acme/widget" },
  pullRequest: {
    id: "300",
    number: 42,
    title: "PR",
    url: "https://github.test/acme/widget/pull/42",
    headSha: "head",
    baseSha: "base"
  },
  actor: { id: "400", login: "reviewer", type: "User" },
  feedback: {
    kind: "review",
    id: "500",
    body: "Please change this",
    state: "changes_requested",
    path: null,
    line: null,
    side: null
  },
  actionable: true,
  occurredAt: "2026-08-05T09:00:00.000Z"
})

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("GitHubRelayConnection", () => {
  it("authenticates, persists before acknowledging, and skips an already persisted cursor", async () => {
    const socket = new FakeSocket()
    const requests: GitHubRelaySocketRequest[] = []
    const order: string[] = []
    let storedCursor = 4
    const connection = new GitHubRelayConnection({
      clientId: "desktop-1:99",
      grant: async () => ({ relayUrl: "https://relay.jingler.test", grant: "short-grant", expiresAt: 1 }),
      cursorStore: {
        load: async () => storedCursor,
        save: async (_clientId, cursor) => {
          order.push(`save:${cursor}`)
          storedCursor = cursor
        }
      },
      dial: (request) => {
        requests.push(request)
        return socket
      },
      onEvent: async (_event, cursor) => {
        order.push(`route:${cursor}`)
      },
      heartbeatMs: 60_000
    })
    await connection.start()
    socket.open()
    expect(requests[0]).toMatchObject({
      url: "wss://relay.jingler.test/events?clientId=desktop-1%3A99&cursor=4",
      headers: { Authorization: "Bearer short-grant" }
    })

    socket.message({ type: "event", cursor: 5, event: event() })
    await flush()
    expect(order).toEqual(["route:5", "save:5"])
    expect(socket.sent).toContain('{"type":"ack","cursor":5}')

    socket.message({ type: "event", cursor: 5, event: event() })
    await flush()
    expect(order).toEqual(["route:5", "save:5"])
    expect(socket.sent.filter((message) => message === '{"type":"ack","cursor":5}')).toHaveLength(2)
    connection.stop()
  })

  it("replays additional chunks and reconnects with the durable cursor", async () => {
    vi.useFakeTimers()
    try {
      const sockets = [new FakeSocket(), new FakeSocket()]
      const requests: GitHubRelaySocketRequest[] = []
      let storedCursor = 0
      let grantCalls = 0
      const connection = new GitHubRelayConnection({
        clientId: "desktop-2:99",
        grant: async () => ({
          relayUrl: "http://127.0.0.1:9200",
          grant: `grant-${++grantCalls}`,
          expiresAt: 1
        }),
        cursorStore: {
          load: async () => storedCursor,
          save: async (_clientId, cursor) => {
            storedCursor = cursor
          }
        },
        dial: (request) => {
          requests.push(request)
          return sockets[requests.length - 1]!
        },
        onEvent: async () => {},
        reconnectBaseMs: 100,
        random: () => 0.5,
        heartbeatMs: 60_000
      })
      await connection.start()
      sockets[0]!.open()
      sockets[0]!.message({ type: "event", cursor: 1, event: event() })
      await flush()
      sockets[0]!.message({ type: "replay-more", cursor: 1 })
      expect(sockets[0]!.sent).toContain('{"type":"resume","cursor":1}')
      sockets[0]!.closed()
      await vi.advanceTimersByTimeAsync(100)
      expect(requests[1]?.url).toContain("cursor=1")
      expect(requests.map((request) => request.headers.Authorization)).toEqual([
        "Bearer grant-1",
        "Bearer grant-2"
      ])
      expect(grantCalls).toBe(2)
      connection.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not acknowledge failed routing and closes so the relay can replay", async () => {
    const socket = new FakeSocket()
    const connection = new GitHubRelayConnection({
      clientId: "desktop-3:99",
      grant: async () => ({ relayUrl: "https://relay.test", grant: "grant", expiresAt: 1 }),
      cursorStore: { load: async () => 0, save: async () => {} },
      dial: () => socket,
      onEvent: async () => {
        throw new Error("persistence failed")
      },
      heartbeatMs: 60_000
    })
    await connection.start()
    socket.open()
    socket.message({ type: "event", cursor: 1, event: event() })
    await flush()
    expect(socket.sent).not.toContain('{"type":"ack","cursor":1}')
    expect(socket.closes).toContainEqual({ code: 1011, reason: "Relay delivery failed" })
    connection.stop()
  })

  it("does not let a later queued frame skip past a failed delivery", async () => {
    const socket = new FakeSocket()
    const routed: number[] = []
    const saved: number[] = []
    const connection = new GitHubRelayConnection({
      clientId: "desktop-4:99",
      grant: async () => ({ relayUrl: "https://relay.test", grant: "grant", expiresAt: 1 }),
      cursorStore: {
        load: async () => 0,
        save: async (_clientId, cursor) => {
          saved.push(cursor)
        }
      },
      dial: () => socket,
      onEvent: async (_event, cursor) => {
        routed.push(cursor)
        if (cursor === 1) throw new Error("first delivery failed")
      },
      heartbeatMs: 60_000,
      reconnectBaseMs: 60_000
    })
    await connection.start()
    socket.open()
    socket.message({ type: "event", cursor: 1, event: event() })
    socket.message({
      type: "event",
      cursor: 2,
      event: { ...event(), deliveryId: "delivery-2", semanticKey: "semantic-2" }
    })
    await flush()
    expect(routed).toEqual([1])
    expect(saved).toEqual([])
    expect(socket.sent).not.toContain('{"type":"ack","cursor":2}')
    connection.stop()
  })

  it("closes and reconnects when a heartbeat pong does not arrive", async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      const connection = new GitHubRelayConnection({
        clientId: "desktop-5:99",
        grant: async () => ({ relayUrl: "https://relay.test", grant: "grant", expiresAt: 1 }),
        cursorStore: { load: async () => 0, save: async () => {} },
        dial: () => socket,
        onEvent: async () => {},
        heartbeatMs: 100,
        pongTimeoutMs: 50,
        reconnectBaseMs: 60_000
      })
      await connection.start()
      socket.open()
      await vi.advanceTimersByTimeAsync(100)
      expect(socket.sent).toContain('{"type":"ping"}')
      await vi.advanceTimersByTimeAsync(49)
      expect(socket.closes).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(socket.closes).toContainEqual({
        code: 1011,
        reason: "Relay heartbeat timed out"
      })
      connection.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
