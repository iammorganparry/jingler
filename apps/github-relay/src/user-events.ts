import { DurableObject } from "cloudflare:workers"
import { RELAY_POLICY } from "./env.js"
import type { NormalizedGitHubEvent } from "./github-webhook.js"

export interface PublishedEvent {
  readonly cursor: number
  readonly event: NormalizedGitHubEvent
}

export interface PublishResult {
  readonly inserted: boolean
  readonly cursor: number | null
}

export interface DispatchResult {
  readonly duplicate: boolean
  readonly routedUsers: number
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

interface SubscriptionRow {
  readonly [key: string]: SqlStorageValue
  readonly user_id: string
}

interface DeliveryRow {
  readonly [key: string]: SqlStorageValue
  readonly delivery_id: string
}

interface ConnectionAttachment {
  readonly clientId: string
  readonly acknowledgedCursor: number
  readonly installationId: string
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
    if (
      (candidate.type === "ack" || candidate.type === "resume") &&
      isCursor(candidate.cursor)
    ) {
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

/** One hibernating, SQLite-backed event stream per Jingler user. */
export class UserEventsObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          cursor INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id TEXT NOT NULL UNIQUE,
          semantic_key TEXT NOT NULL UNIQUE,
          installation_id TEXT,
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
      // Existing Durable Objects predate installation-isolated replay. SQLite
      // has no `ADD COLUMN IF NOT EXISTS`, so tolerate the duplicate-column
      // error after the first migration.
      try {
        this.ctx.storage.sql.exec("ALTER TABLE events ADD COLUMN installation_id TEXT")
      } catch {
        // Column already exists.
      }
    })
  }

  async publish(event: NormalizedGitHubEvent): Promise<PublishResult> {
    const rows = this.ctx.storage.sql
      .exec<CursorRow>(
        `INSERT OR IGNORE INTO events (delivery_id, semantic_key, installation_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING cursor`,
        event.deliveryId,
        event.semanticKey,
        event.installationId,
        JSON.stringify(event),
        Date.now()
      )
      .toArray()
    const cursor = rows[0]?.cursor ?? null
    if (cursor === null) return { inserted: false, cursor: null }

    this.prune()
    const envelope = { type: "event", cursor, event } as const
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(socket)
      if (!attachment || attachment.installationId !== event.installationId) continue
      safeSend(socket, envelope)
    }
    return { inserted: true, cursor }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLocaleLowerCase("en-US") !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 })
    }
    const clientId = request.headers.get("x-jingler-client-id")
    const installationId = request.headers.get("x-jingler-installation-id")
    const expiresAt = Number(request.headers.get("x-jingler-expires-at") ?? "0")
    const requestedCursor = Number(request.headers.get("x-jingler-cursor") ?? "0")
    if (
      !clientId ||
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(clientId) ||
      !installationId ||
      !/^\d+$/.test(installationId) ||
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
      installationId,
      expiresAt
    } satisfies ConnectionAttachment)
    await this.scheduleExpiryAlarm()
    const newestCursor =
      this.ctx.storage.sql.exec<CursorRow>("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events").one()
        .cursor
    safeSend(server, { type: "hello", cursor, newestCursor })
    this.replay(server, cursor, installationId)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const currentAttachment = this.attachment(socket)
    if (!currentAttachment) return
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
      this.replay(socket, message.cursor, currentAttachment.installationId)
      return
    }

    const attachment = currentAttachment
    if (!attachment || message.cursor < attachment.acknowledgedCursor) return
    const newestCursor =
      this.ctx.storage.sql.exec<CursorRow>("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events").one()
        .cursor
    const acknowledgedCursor = Math.min(message.cursor, newestCursor)
    this.ctx.storage.sql.exec(
      `INSERT INTO client_acks (client_id, cursor, seen_at) VALUES (?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         cursor = MAX(client_acks.cursor, excluded.cursor),
         seen_at = excluded.seen_at`,
      attachment.clientId,
      acknowledgedCursor,
      Date.now()
    )
    socket.serializeAttachment({
      ...attachment,
      acknowledgedCursor
    } satisfies ConnectionAttachment)
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

  async revokeInstallation(installationId: string): Promise<number> {
    let closed = 0
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
      if (attachment?.installationId !== installationId) continue
      socket.close(4003, "Subscription revoked")
      closed += 1
    }
    await this.scheduleExpiryAlarm()
    return closed
  }

  private replay(socket: WebSocket, cursor: number, installationId: string): void {
    const rows = this.ctx.storage.sql
      .exec<StoredEventRow>(
        `SELECT cursor, payload FROM events
         WHERE cursor > ? AND installation_id = ?
         ORDER BY cursor ASC LIMIT ?`,
        cursor,
        installationId,
        RELAY_POLICY.maxReplayEvents + 1
      )
      .toArray()
    const replayRows = rows.slice(0, RELAY_POLICY.maxReplayEvents)
    for (const row of replayRows) {
      safeSend(socket, {
        type: "event",
        cursor: row.cursor,
        event: JSON.parse(row.payload) as unknown
      })
    }
    if (rows.length > RELAY_POLICY.maxReplayEvents) {
      safeSend(socket, {
        type: "replay-more",
        cursor: replayRows.at(-1)?.cursor ?? cursor
      })
    }
  }

  private attachment(socket: WebSocket): ConnectionAttachment | null {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
    if (
      !attachment ||
      typeof attachment.installationId !== "string" ||
      !Number.isSafeInteger(attachment.expiresAt) ||
      attachment.expiresAt <= Date.now()
    ) {
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
      .filter((expiresAt): expiresAt is number =>
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
    this.ctx.storage.sql.exec("DELETE FROM events WHERE created_at < ?", cutoff)
    const count = this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM events").one()
      .count
    if (count > RELAY_POLICY.maxStoredEvents) {
      this.ctx.storage.sql.exec(
        `DELETE FROM events WHERE cursor IN (
          SELECT cursor FROM events ORDER BY cursor ASC LIMIT ?
        )`,
        count - RELAY_POLICY.maxStoredEvents
      )
    }
    this.ctx.storage.sql.exec("DELETE FROM client_acks WHERE seen_at < ?", cutoff)
  }
}

/**
 * GitHub identifies webhook recipients by installation id. This small routing
 * object records the user subscriptions established by verified relay grants,
 * then fans each delivery into the corresponding per-user object.
 */
export class InstallationRoutesObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          user_id TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS subscriptions_expires_at ON subscriptions(expires_at);
        CREATE TABLE IF NOT EXISTS deliveries (
          delivery_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS deliveries_created_at ON deliveries(created_at);
      `)
    })
  }

  async subscribe(userId: string, expiresAt: number): Promise<void> {
    const now = Date.now()
    this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE expires_at <= ?", now)
    this.ctx.storage.sql.exec(
      `INSERT INTO subscriptions (user_id, expires_at) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET expires_at = MAX(subscriptions.expires_at, excluded.expires_at)`,
      userId,
      expiresAt
    )
    const count = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM subscriptions")
      .one().count
    if (count > RELAY_POLICY.maxSubscriptionsPerInstallation) {
      this.ctx.storage.sql.exec(
        `DELETE FROM subscriptions WHERE user_id IN (
          SELECT user_id FROM subscriptions ORDER BY expires_at ASC LIMIT ?
        )`,
        count - RELAY_POLICY.maxSubscriptionsPerInstallation
      )
    }
  }

  async unsubscribe(userId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE user_id = ?", userId)
  }

  async revokeAll(installationId: string): Promise<number> {
    const users = this.ctx.storage.sql
      .exec<SubscriptionRow>("SELECT user_id FROM subscriptions ORDER BY user_id")
      .toArray()
    await Promise.all(
      users.map((row) =>
        this.env.USER_EVENTS.getByName(row.user_id).revokeInstallation(installationId)
      )
    )
    this.ctx.storage.sql.exec("DELETE FROM subscriptions")
    return users.length
  }

  async dispatch(event: NormalizedGitHubEvent): Promise<DispatchResult> {
    const existing = this.ctx.storage.sql
      .exec<DeliveryRow>("SELECT delivery_id FROM deliveries WHERE delivery_id = ?", event.deliveryId)
      .toArray()
    if (existing.length > 0) return { duplicate: true, routedUsers: 0 }

    const cutoff = Date.now() - RELAY_POLICY.eventRetentionMs
    this.ctx.storage.sql.exec("DELETE FROM deliveries WHERE created_at < ?", cutoff)
    this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE expires_at <= ?", Date.now())
    const users = this.ctx.storage.sql
      .exec<SubscriptionRow>("SELECT user_id FROM subscriptions ORDER BY user_id")
      .toArray()
    await Promise.all(
      users.map((row) => this.env.USER_EVENTS.getByName(row.user_id).publish(event))
    )
    // Mark complete only after every per-user publish succeeds. A retried partial
    // fan-out is safe because each user stream has its own delivery idempotency key.
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO deliveries (delivery_id, created_at) VALUES (?, ?)",
      event.deliveryId,
      Date.now()
    )
    return { duplicate: false, routedUsers: users.length }
  }
}
