import type { GitHubRelayEvent } from "../../../packages/cli-adapters/src/github-events.js"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { WebSocket, WebSocketServer, type RawData } from "ws"

export interface FakeGitHubRelay {
  readonly url: string
  readonly grant: string
  readonly requests: ReadonlyArray<{ readonly path: string; readonly authorized: boolean }>
  readonly acknowledgements: ReadonlyArray<{ readonly clientId: string; readonly cursor: number }>
  readonly publish: (event: GitHubRelayEvent) => number | null
  readonly disconnectAll: () => void
  readonly close: () => Promise<void>
}

interface StoredEvent {
  readonly cursor: number
  readonly event: GitHubRelayEvent
}

interface ClientState {
  readonly clientId: string
  readonly socket: WebSocket
}

const safeSend = (socket: WebSocket, value: unknown): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}

const message = (value: RawData): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(value.toString())
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Offline websocket relay used by the real Electron realtime-feedback e2e. */
export const startFakeGitHubRelay = async (
  grant = "e2e-short-lived-relay-grant"
): Promise<FakeGitHubRelay> => {
  const requests: Array<{ path: string; authorized: boolean }> = []
  const acknowledgements: Array<{ clientId: string; cursor: number }> = []
  const events: StoredEvent[] = []
  const deliveryIds = new Set<string>()
  const semanticKeys = new Set<string>()
  const acknowledgementsByClient = new Map<string, number>()
  const clients = new Set<ClientState>()
  const webSockets = new WebSocketServer({ noServer: true })
  let nextCursor = 1

  const replay = (client: ClientState, after: number): void => {
    for (const stored of events.filter((candidate) => candidate.cursor > after)) {
      safeSend(client.socket, { type: "event", cursor: stored.cursor, event: stored.event })
    }
  }

  webSockets.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const clientId = url.searchParams.get("clientId") ?? ""
    const requested = Number(url.searchParams.get("cursor") ?? "0")
    const persisted = acknowledgementsByClient.get(clientId) ?? 0
    const cursor = Math.max(Number.isSafeInteger(requested) ? requested : 0, persisted)
    const client = { clientId, socket }
    clients.add(client)
    safeSend(socket, {
      type: "hello",
      cursor,
      newestCursor: events.at(-1)?.cursor ?? 0
    })
    replay(client, cursor)

    socket.on("message", (raw) => {
      const parsed = message(raw)
      if (parsed?.type === "ping") {
        safeSend(socket, { type: "pong", at: Date.now() })
        return
      }
      if (
        parsed?.type === "resume" &&
        typeof parsed.cursor === "number" &&
        Number.isSafeInteger(parsed.cursor)
      ) {
        replay(client, parsed.cursor)
        return
      }
      if (
        parsed?.type === "ack" &&
        typeof parsed.cursor === "number" &&
        Number.isSafeInteger(parsed.cursor)
      ) {
        const acknowledged = Math.max(acknowledgementsByClient.get(clientId) ?? 0, parsed.cursor)
        acknowledgementsByClient.set(clientId, acknowledged)
        acknowledgements.push({ clientId, cursor: acknowledged })
      }
    })
    socket.on("close", () => clients.delete(client))
  })

  let server!: Server
  const url = await new Promise<string>((resolve, reject) => {
    server = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "Not found" }))
    })
    server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1")
      const authorized = request.headers.authorization === `Bearer ${grant}`
      requests.push({ path: requestUrl.pathname, authorized })
      if (requestUrl.pathname !== "/events" || !authorized) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
        socket.destroy()
        return
      }
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit("connection", webSocket, request)
      })
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })

  return {
    url,
    grant,
    requests,
    acknowledgements,
    publish: (event) => {
      if (deliveryIds.has(event.deliveryId) || semanticKeys.has(event.semanticKey)) return null
      deliveryIds.add(event.deliveryId)
      semanticKeys.add(event.semanticKey)
      const cursor = nextCursor++
      events.push({ cursor, event })
      for (const client of clients) {
        safeSend(client.socket, { type: "event", cursor, event })
      }
      return cursor
    },
    disconnectAll: () => {
      for (const client of [...clients]) client.socket.close(1012, "Fake relay restart")
    },
    close: async () => {
      for (const client of [...clients]) client.socket.terminate()
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve()
        }
        const timeout = setTimeout(() => {
          server.closeAllConnections()
          finish()
        }, 2_000)
        webSockets.close(() => {
          server.close(finish)
        })
      })
    }
  }
}
