import { DurableObject } from "cloudflare:workers"
import { RELAY_POLICY, relayTelemetry } from "./env.js"
import type { NormalizedGitHubEvent } from "./github-webhook.js"

export interface PublishResult {
  readonly inserted: boolean
  readonly cursor: number | null
}

interface StoredEventRow {
  readonly [key: string]: SqlStorageValue
  readonly cursor: number
  readonly payload: string
}

interface CursorRow {
  readonly [key: string]: SqlStorageValue
  readonly cursor: number
}

interface CountRow {
  readonly [key: string]: SqlStorageValue
  readonly count: number
}

interface ConnectionAttachment {
  readonly clientId: string
  readonly acknowledgedCursor: number
  readonly expiresAt: number
}

type ClientMessage =
  | { readonly type: "ack"; readonly cursor: number }
  | { readonly type: "resume"; readonly cursor: number }
  | { readonly type: "ping" }

const isCursor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const parseClientMessage = (message: string): ClientMessage | null => {
  try {
    const value: unknown = JSON.parse(message)
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const candidate = value as Record<string, unknown>
    if (candidate.type === "ping") return { type: "ping" }
    if ((candidate.type === "ack" || candidate.type === "resume") && isCursor(candidate.cursor)) {
      return { type: candidate.type, cursor: candidate.cursor }
    }
    return null
  } catch {
    return null
  }
}

const safeSend = (socket: WebSocket, value: unknown): boolean => {
  try {
    socket.send(JSON.stringify(value))
    return true
  } catch {
    try {
      socket.close(1011, "Delivery failed")
    } catch {
      // The runtime already considers the socket closed.
    }
    return false
  }
}

/** One hibernating, SQLite-backed event stream per opaque Jingler relay session id. */
export class SessionEventsObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          cursor INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id TEXT NOT NULL UNIQUE,
          semantic_key TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_created_at ON events(created_at);
        CREATE TABLE IF NOT EXISTS client_acks (
          client_id TEXT PRIMARY KEY,
          cursor INTEGER NOT NULL,
          seen_at INTEGER NOT NULL
        );
      `)
    })
  }

  async publish(event: NormalizedGitHubEvent): Promise<PublishResult> {
    const rows = this.ctx.storage.sql
      .exec<CursorRow>(
        `INSERT OR IGNORE INTO events (delivery_id, semantic_key, payload, created_at)
         VALUES (?, ?, ?, ?) RETURNING cursor`,
        event.deliveryId,
        event.semanticKey,
        JSON.stringify(event),
        Date.now()
      )
      .toArray()
    const cursor = rows[0]?.cursor ?? null
    if (cursor === null) return { inserted: false, cursor: null }

    this.prune()
    const envelope = { type: "event", cursor, event } as const
    for (const socket of this.ctx.getWebSockets()) safeSend(socket, envelope)
    return { inserted: true, cursor }
  }

  async eventCount(): Promise<number> {
    return this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM events").one().count
  }

  async closeSockets(reason = "Session route revoked"): Promise<number> {
    let closed = 0
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(4003, reason)
      closed += 1
    }
    await this.scheduleExpiryAlarm()
    return closed
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLocaleLowerCase("en-US") !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 })
    }
    const clientId = request.headers.get("x-jingler-client-id")
    const expiresAt = Number(request.headers.get("x-jingler-expires-at") ?? "0")
    const requestedCursor = Number(request.headers.get("x-jingler-cursor") ?? "0")
    if (
      !clientId ||
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(clientId) ||
      !isCursor(requestedCursor) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      return Response.json({ error: "Invalid relay cursor or client id" }, { status: 400 })
    }

    const persisted = this.ctx.storage.sql
      .exec<CursorRow>("SELECT cursor FROM client_acks WHERE client_id = ?", clientId)
      .toArray()[0]?.cursor
    const cursor = Math.max(requestedCursor, persisted ?? 0)
    this.ctx.storage.sql.exec(
      `INSERT INTO client_acks (client_id, cursor, seen_at) VALUES (?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         cursor = MAX(client_acks.cursor, excluded.cursor),
         seen_at = excluded.seen_at`,
      clientId,
      cursor,
      Date.now()
    )

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({
      clientId,
      acknowledgedCursor: cursor,
      expiresAt
    } satisfies ConnectionAttachment)
    await this.scheduleExpiryAlarm()
    const newestCursor = this.newestCursor()
    safeSend(server, { type: "hello", cursor, newestCursor })
    this.replay(server, cursor)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(
    socket: WebSocket,
    rawMessage: string | ArrayBuffer
  ): Promise<void> {
    const attachment = this.attachment(socket)
    if (!attachment) return
    if (typeof rawMessage !== "string") {
      safeSend(socket, { type: "error", code: "invalid-message" })
      return
    }
    const message = parseClientMessage(rawMessage)
    if (!message) {
      safeSend(socket, { type: "error", code: "invalid-message" })
      return
    }
    if (message.type === "ping") {
      safeSend(socket, { type: "pong", at: Date.now() })
      return
    }
    if (message.type === "resume") {
      this.replay(socket, message.cursor)
      return
    }
    if (message.cursor < attachment.acknowledgedCursor) return
    const acknowledgedCursor = Math.min(message.cursor, this.newestCursor())
    this.ctx.storage.sql.exec(
      `INSERT INTO client_acks (client_id, cursor, seen_at) VALUES (?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         cursor = MAX(client_acks.cursor, excluded.cursor),
         seen_at = excluded.seen_at`,
      attachment.clientId,
      acknowledgedCursor,
      Date.now()
    )
    socket.serializeAttachment({ ...attachment, acknowledgedCursor } satisfies ConnectionAttachment)
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    socket.close(code, reason)
    await this.scheduleExpiryAlarm()
  }

  override async alarm(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) this.attachment(socket)
    await this.scheduleExpiryAlarm()
  }

  private newestCursor(): number {
    return this.ctx.storage.sql
      .exec<CursorRow>("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events")
      .one().cursor
  }

  private replay(socket: WebSocket, cursor: number): void {
    const rows = this.ctx.storage.sql
      .exec<StoredEventRow>(
        `SELECT cursor, payload FROM events WHERE cursor > ? ORDER BY cursor ASC LIMIT ?`,
        cursor,
        RELAY_POLICY.maxReplayEvents + 1
      )
      .toArray()
    const replayRows = rows.slice(0, RELAY_POLICY.maxReplayEvents)
    relayTelemetry("replay_depth", {
      replayDepth: replayRows.length,
      hasMore: rows.length > RELAY_POLICY.maxReplayEvents
    })
    for (const row of replayRows) {
      safeSend(socket, {
        type: "event",
        cursor: row.cursor,
        event: JSON.parse(row.payload) as NormalizedGitHubEvent
      })
    }
    const overflow = rows[RELAY_POLICY.maxReplayEvents]
    if (overflow) safeSend(socket, { type: "replay-more", cursor: replayRows.at(-1)?.cursor ?? cursor })
  }

  private attachment(socket: WebSocket): ConnectionAttachment | null {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment || attachment.expiresAt <= Date.now()) {
      socket.close(4001, "Relay grant expired")
      return null
    }
    return attachment
  }

  private async scheduleExpiryAlarm(): Promise<void> {
    const expiries = this.ctx
      .getWebSockets()
      .map((socket) => socket.deserializeAttachment() as ConnectionAttachment | null)
      .map((attachment) => attachment?.expiresAt)
      .filter(
        (expiresAt): expiresAt is number =>
          typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > Date.now()
      )
    if (expiries.length === 0) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    await this.ctx.storage.setAlarm(Math.min(...expiries))
  }

  private prune(): void {
    const cutoff = Date.now() - RELAY_POLICY.eventRetentionMs
    let compacted = this.ctx.storage.sql.exec("DELETE FROM events WHERE created_at < ?", cutoff)
      .rowsWritten
    const count = this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM events").one()
      .count
    if (count > RELAY_POLICY.maxStoredEvents) {
      compacted += this.ctx.storage.sql.exec(
        `DELETE FROM events WHERE cursor IN (
          SELECT cursor FROM events ORDER BY cursor ASC LIMIT ?
        )`,
        count - RELAY_POLICY.maxStoredEvents
      ).rowsWritten
    }
    const staleAcks = this.ctx.storage.sql.exec("DELETE FROM client_acks WHERE seen_at < ?", cutoff)
      .rowsWritten
    if (compacted > 0 || staleAcks > 0) {
      relayTelemetry("retention_compaction", { compactedEvents: compacted, staleAcks })
    }
  }
}
