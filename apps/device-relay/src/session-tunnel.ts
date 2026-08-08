import type {
  EncryptedTunnelEnvelope,
  TunnelClientMessage,
  TunnelEndpoint
} from "@jingler/core"
import {
  EncryptedTunnelEnvelope as EncryptedTunnelEnvelopeSchema,
  TunnelClientMessage as TunnelClientMessageSchema
} from "@jingler/core"
import { DurableObject } from "cloudflare:workers"
import { Either, Schema } from "effect"
import { deviceRelayTelemetry } from "./telemetry.js"

export const TUNNEL_POLICY = {
  maxStoredEnvelopes: 2_048,
  maxReplayEnvelopes: 256,
  retentionSeconds: 24 * 60 * 60,
  maximumMessageBytes: 1_100_000
} as const

interface TunnelMetadataRow {
  readonly [key: string]: SqlStorageValue
  readonly session_id: string
  readonly subject: string
  readonly device_id: string
  readonly device_generation: number
  readonly expires_at: number
}

interface EnvelopeRow {
  readonly [key: string]: SqlStorageValue
  readonly sender: TunnelEndpoint
  readonly sequence: number
  readonly payload: string
  readonly created_at: number
}

interface SequenceRow {
  readonly [key: string]: SqlStorageValue
  readonly sequence: number
}

interface AcknowledgementRow {
  readonly [key: string]: SqlStorageValue
  readonly acknowledged_sequence: number
}

interface RevocationRow {
  readonly [key: string]: SqlStorageValue
  readonly revoked_generation: number
}

interface CountRow {
  readonly [key: string]: SqlStorageValue
  readonly count: number
}

interface TunnelSocketAttachment {
  readonly endpoint: TunnelEndpoint
  readonly sessionId: string
  readonly subject: string
  readonly deviceId: string
  readonly generation: number
  readonly expiresAt: number
}

export interface TunnelInitialization {
  readonly sessionId: string
  readonly subject: string
  readonly deviceId: string
  readonly deviceGeneration: number
  readonly expiresAt: number
}

export type PublishEnvelopeResult =
  | { readonly status: "inserted"; readonly sequence: number }
  | { readonly status: "duplicate"; readonly sequence: number }
  | { readonly status: "sequence-gap"; readonly expectedSequence: number }
  | { readonly status: "sequence-conflict"; readonly sequence: number }
  | { readonly status: "invalid-envelope" }

const opposite = (endpoint: TunnelEndpoint): TunnelEndpoint =>
  endpoint === "desktop" ? "device" : "desktop"

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

const safeClose = (socket: WebSocket, code: number, reason: string): void => {
  try {
    socket.close(code, reason)
  } catch {
    // The runtime already considers the socket closed.
  }
}

const parseInteger = (value: string | null): number | null => {
  if (!value || !/^\d+$/.test(value)) return null
  const integer = Number(value)
  return Number.isSafeInteger(integer) ? integer : null
}

const parseEndpoint = (value: string | null): TunnelEndpoint | null =>
  value === "desktop" || value === "device" ? value : null

const parseMessage = (raw: string): TunnelClientMessage | null => {
  try {
    const decoded = Schema.decodeUnknownEither(TunnelClientMessageSchema)(JSON.parse(raw), {
      onExcessProperty: "error"
    })
    return Either.isRight(decoded) ? decoded.right : null
  } catch {
    return null
  }
}

/** One encrypted, replayable, hibernating bidirectional stream per remote session. */
export class SessionTunnelObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tunnel_metadata (
          session_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          device_id TEXT NOT NULL,
          device_generation INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS encrypted_envelopes (
          sender TEXT NOT NULL CHECK (sender IN ('desktop', 'device')),
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (sender, sequence)
        );
        CREATE INDEX IF NOT EXISTS encrypted_envelopes_time ON encrypted_envelopes(created_at);
        CREATE TABLE IF NOT EXISTS sequence_cursors (
          sender TEXT PRIMARY KEY CHECK (sender IN ('desktop', 'device')),
          sequence INTEGER NOT NULL CHECK (sequence >= 0)
        );
        INSERT OR IGNORE INTO sequence_cursors (sender, sequence)
          SELECT sender, MAX(sequence) FROM encrypted_envelopes GROUP BY sender;
        CREATE TABLE IF NOT EXISTS acknowledgements (
          endpoint TEXT PRIMARY KEY CHECK (endpoint IN ('desktop', 'device')),
          acknowledged_sequence INTEGER NOT NULL CHECK (acknowledged_sequence >= 0),
          seen_at INTEGER NOT NULL
        );
        INSERT INTO sequence_cursors (sender, sequence)
          SELECT CASE endpoint WHEN 'desktop' THEN 'device' ELSE 'desktop' END,
                 acknowledged_sequence
          FROM acknowledgements
          WHERE true
          ON CONFLICT(sender) DO UPDATE SET
            sequence = MAX(sequence_cursors.sequence, excluded.sequence);
        CREATE TABLE IF NOT EXISTS tunnel_revocations (
          device_id TEXT PRIMARY KEY,
          revoked_generation INTEGER NOT NULL,
          revoked_at INTEGER NOT NULL
        );
      `)
    })
  }

  async schemaVersion(): Promise<number> {
    return 1
  }

  async initialize(
    input: TunnelInitialization,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<boolean> {
    const existing = this.metadata()
    const revokedGeneration = this.revokedGeneration(input.deviceId)
    if (revokedGeneration !== null && input.deviceGeneration < revokedGeneration) return false
    if (
      existing &&
      (existing.session_id !== input.sessionId ||
        existing.subject !== input.subject ||
        existing.device_id !== input.deviceId)
    ) {
      return false
    }
    if (!existing) {
      this.ctx.storage.sql.exec(
        `INSERT INTO tunnel_metadata (
           session_id, subject, device_id, device_generation, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.sessionId,
        input.subject,
        input.deviceId,
        input.deviceGeneration,
        input.expiresAt,
        nowSeconds,
        nowSeconds
      )
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE tunnel_metadata SET
           device_generation = MAX(device_generation, ?),
           expires_at = MAX(expires_at, ?),
           updated_at = ?
         WHERE session_id = ?`,
        input.deviceGeneration,
        input.expiresAt,
        nowSeconds,
        input.sessionId
      )
    }
    await this.scheduleAlarm()
    return true
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLocaleLowerCase("en-US") !== "websocket") {
      return Response.json({ error: "Expected websocket upgrade" }, { status: 426 })
    }
    const endpoint = parseEndpoint(request.headers.get("x-jingler-endpoint"))
    const sessionId = request.headers.get("x-jingler-session-id")
    const subject = request.headers.get("x-jingler-subject")
    const deviceId = request.headers.get("x-jingler-device-id")
    const generation = parseInteger(request.headers.get("x-jingler-device-generation"))
    const expiresAt = parseInteger(request.headers.get("x-jingler-expires-at"))
    const requestedAcknowledgement =
      parseInteger(request.headers.get("x-jingler-acknowledged-sequence")) ?? 0
    const metadata = this.metadata()
    const nowSeconds = Math.floor(Date.now() / 1_000)
    if (
      !endpoint ||
      !sessionId ||
      !subject ||
      !deviceId ||
      generation === null ||
      expiresAt === null ||
      expiresAt <= nowSeconds ||
      !metadata ||
      metadata.session_id !== sessionId ||
      metadata.subject !== subject ||
      metadata.device_id !== deviceId ||
      generation !== metadata.device_generation ||
      (this.revokedGeneration(deviceId) ?? 0) > generation
    ) {
      return Response.json({ error: "Tunnel admission rejected" }, { status: 403 })
    }

    for (const socket of this.ctx.getWebSockets(`endpoint:${endpoint}`)) {
      safeClose(socket, 4002, "Connection replaced")
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, [`endpoint:${endpoint}`, `device:${deviceId}`])
    server.serializeAttachment({
      endpoint,
      sessionId,
      subject,
      deviceId,
      generation,
      expiresAt
    } satisfies TunnelSocketAttachment)
    const acknowledgedSequence = Math.max(
      requestedAcknowledgement,
      this.acknowledgedSequence(endpoint)
    )
    safeSend(server, {
      type: "hello",
      version: 1,
      endpoint,
      sessionId,
      acknowledgedSequence,
      nextSequence: this.newestSequence(endpoint) + 1
    })
    this.replay(server, endpoint, acknowledgedSequence)
    await this.scheduleAlarm()
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(
    socket: WebSocket,
    rawMessage: string | ArrayBuffer
  ): Promise<void> {
    const attachment = this.attachment(socket)
    if (!attachment) return
    if (
      typeof rawMessage !== "string" ||
      new TextEncoder().encode(rawMessage).byteLength > TUNNEL_POLICY.maximumMessageBytes
    ) {
      safeSend(socket, { type: "error", code: "invalid-message" })
      return
    }
    const message = parseMessage(rawMessage)
    if (!message) {
      safeSend(socket, { type: "error", code: "invalid-message" })
      return
    }
    switch (message.type) {
      case "ping":
        safeSend(socket, { type: "pong", at: Math.floor(Date.now() / 1_000) })
        return
      case "resume":
        this.replay(socket, attachment.endpoint, message.acknowledgedSequence)
        return
      case "ack": {
        if (
          message.acknowledgement.sessionId !== attachment.sessionId ||
          message.acknowledgement.sender !== attachment.endpoint
        ) {
          safeSend(socket, { type: "error", code: "invalid-acknowledgement" })
          return
        }
        const acknowledged = this.acknowledge(
          attachment.endpoint,
          message.acknowledgement.acknowledgedSequence
        )
        safeSend(socket, { type: "acknowledged", sequence: acknowledged })
        for (const peer of this.ctx.getWebSockets(`endpoint:${opposite(attachment.endpoint)}`)) {
          safeSend(peer, { type: "peer-acknowledged", sequence: acknowledged })
        }
        return
      }
      case "envelope": {
        const result = this.publishEnvelope(attachment.endpoint, message.envelope)
        safeSend(socket, { type: "envelope-result", ...result })
        return
      }
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    safeClose(socket, code, reason)
    await this.scheduleAlarm()
  }

  override async alarm(): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1_000)
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(socket)
      if (!attachment || attachment.expiresAt <= nowSeconds) {
        safeClose(socket, 4001, "Tunnel grant expired")
      }
    }
    this.prune(nowSeconds)
    await this.scheduleAlarm()
  }

  publishEnvelope(endpoint: TunnelEndpoint, envelope: EncryptedTunnelEnvelope): PublishEnvelopeResult {
    const decoded = Schema.decodeUnknownEither(EncryptedTunnelEnvelopeSchema)(envelope, {
      onExcessProperty: "error"
    })
    if (Either.isLeft(decoded)) return { status: "invalid-envelope" }
    const normalized = decoded.right
    const metadata = this.metadata()
    if (
      !metadata ||
      normalized.sessionId !== metadata.session_id ||
      normalized.sender !== endpoint
    ) {
      return { status: "invalid-envelope" }
    }
    const newest = this.newestSequence(endpoint)
    if (normalized.sequence > newest + 1) {
      return { status: "sequence-gap", expectedSequence: newest + 1 }
    }
    const payload = JSON.stringify(normalized)
    if (normalized.sequence <= newest) {
      const existing = this.ctx.storage.sql
        .exec<EnvelopeRow>(
          `SELECT sender, sequence, payload, created_at FROM encrypted_envelopes
           WHERE sender = ? AND sequence = ?`,
          endpoint,
          normalized.sequence
        )
        .toArray()[0]
      return existing?.payload === payload
        ? { status: "duplicate", sequence: normalized.sequence }
        : { status: "sequence-conflict", sequence: normalized.sequence }
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO encrypted_envelopes (sender, sequence, payload, created_at)
         VALUES (?, ?, ?, ?)`,
        endpoint,
        normalized.sequence,
        payload,
        Math.floor(Date.now() / 1_000)
      )
      this.ctx.storage.sql.exec(
        `INSERT INTO sequence_cursors (sender, sequence) VALUES (?, ?)
         ON CONFLICT(sender) DO UPDATE SET sequence = MAX(sequence_cursors.sequence, excluded.sequence)`,
        endpoint,
        normalized.sequence
      )
    })
    for (const socket of this.ctx.getWebSockets(`endpoint:${opposite(endpoint)}`)) {
      safeSend(socket, { type: "envelope", envelope: normalized })
    }
    this.prune(Math.floor(Date.now() / 1_000))
    return { status: "inserted", sequence: normalized.sequence }
  }

  acknowledge(endpoint: TunnelEndpoint, requestedSequence: number): number {
    const source = opposite(endpoint)
    const sequence = Math.min(requestedSequence, this.newestSequence(source))
    const acknowledged = Math.max(sequence, this.acknowledgedSequence(endpoint))
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO acknowledgements (endpoint, acknowledged_sequence, seen_at)
         VALUES (?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           acknowledged_sequence = MAX(acknowledgements.acknowledged_sequence, excluded.acknowledged_sequence),
           seen_at = excluded.seen_at`,
        endpoint,
        acknowledged,
        Math.floor(Date.now() / 1_000)
      )
      this.ctx.storage.sql.exec(
        "DELETE FROM encrypted_envelopes WHERE sender = ? AND sequence <= ?",
        source,
        acknowledged
      )
    })
    return acknowledged
  }

  async revokeDevice(
    deviceId: string,
    generation: number,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<number> {
    this.ctx.storage.sql.exec(
      `INSERT INTO tunnel_revocations (device_id, revoked_generation, revoked_at)
       VALUES (?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         revoked_generation = MAX(tunnel_revocations.revoked_generation, excluded.revoked_generation),
         revoked_at = excluded.revoked_at`,
      deviceId,
      generation,
      nowSeconds
    )
    let closed = 0
    for (const socket of this.ctx.getWebSockets(`device:${deviceId}`)) {
      safeClose(socket, 4003, "Device revoked")
      closed += 1
    }
    deviceRelayTelemetry("device_revocation", {
      deviceId,
      generation,
      reason: "tunnel-close",
      sessionId: this.metadata()?.session_id ?? null,
      tunnelSocketsClosed: closed
    })
    await this.scheduleAlarm()
    return closed
  }

  async envelopeCount(): Promise<number> {
    return this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM encrypted_envelopes")
      .one().count
  }

  async storedSequences(sender: TunnelEndpoint): Promise<ReadonlyArray<number>> {
    return this.ctx.storage.sql
      .exec<SequenceRow>(
        "SELECT sequence FROM encrypted_envelopes WHERE sender = ? ORDER BY sequence ASC",
        sender
      )
      .toArray()
      .map((row) => row.sequence)
  }

  private metadata(): TunnelMetadataRow | null {
    return this.ctx.storage.sql.exec<TunnelMetadataRow>("SELECT * FROM tunnel_metadata LIMIT 1")
      .toArray()[0] ?? null
  }

  private revokedGeneration(deviceId: string): number | null {
    return (
      this.ctx.storage.sql
        .exec<RevocationRow>(
          "SELECT revoked_generation FROM tunnel_revocations WHERE device_id = ?",
          deviceId
        )
        .toArray()[0]?.revoked_generation ?? null
    )
  }

  private newestSequence(sender: TunnelEndpoint): number {
    return (
      this.ctx.storage.sql
        .exec<SequenceRow>("SELECT sequence FROM sequence_cursors WHERE sender = ?", sender)
        .toArray()[0]?.sequence ?? 0
    )
  }

  private acknowledgedSequence(endpoint: TunnelEndpoint): number {
    return (
      this.ctx.storage.sql
        .exec<AcknowledgementRow>(
          "SELECT acknowledged_sequence FROM acknowledgements WHERE endpoint = ?",
          endpoint
        )
        .toArray()[0]?.acknowledged_sequence ?? 0
    )
  }

  private replay(socket: WebSocket, endpoint: TunnelEndpoint, requestedSequence: number): void {
    const source = opposite(endpoint)
    const cursor = Math.max(requestedSequence, this.acknowledgedSequence(endpoint))
    const oldest = this.ctx.storage.sql
      .exec<SequenceRow>(
        "SELECT COALESCE(MIN(sequence), 0) AS sequence FROM encrypted_envelopes WHERE sender = ?",
        source
      )
      .one().sequence
    if (oldest > 0 && cursor < oldest - 1) {
      safeSend(socket, { type: "replay-truncated", acknowledgedSequence: cursor, oldestSequence: oldest })
      deviceRelayTelemetry(
        "replay_truncation",
        {
          acknowledgedSequence: cursor,
          endpoint,
          oldestSequence: oldest,
          sessionId: this.metadata()?.session_id ?? null
        },
        "warn"
      )
    }
    const rows = this.ctx.storage.sql
      .exec<EnvelopeRow>(
        `SELECT sender, sequence, payload, created_at FROM encrypted_envelopes
         WHERE sender = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
        source,
        cursor,
        TUNNEL_POLICY.maxReplayEnvelopes + 1
      )
      .toArray()
    const replayRows = rows.slice(0, TUNNEL_POLICY.maxReplayEnvelopes)
    deviceRelayTelemetry("reconnect_depth", {
      acknowledgedSequence: cursor,
      endpoint,
      hasMore: rows.length > TUNNEL_POLICY.maxReplayEnvelopes,
      replayDepth: replayRows.length,
      sessionId: this.metadata()?.session_id ?? null
    })
    for (const row of replayRows) {
      safeSend(socket, { type: "envelope", envelope: JSON.parse(row.payload) })
    }
    if (rows.length > TUNNEL_POLICY.maxReplayEnvelopes) {
      safeSend(socket, {
        type: "replay-more",
        sequence: replayRows.at(-1)?.sequence ?? cursor
      })
    }
  }

  private attachment(socket: WebSocket): TunnelSocketAttachment | null {
    const attachment = this.readAttachment(socket)
    if (!attachment || attachment.expiresAt <= Math.floor(Date.now() / 1_000)) {
      safeClose(socket, 4001, "Tunnel grant expired")
      return null
    }
    if ((this.revokedGeneration(attachment.deviceId) ?? 0) > attachment.generation) {
      safeClose(socket, 4003, "Device revoked")
      return null
    }
    return attachment
  }

  private readAttachment(socket: WebSocket): TunnelSocketAttachment | null {
    const value: unknown = socket.deserializeAttachment()
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const candidate = Object.fromEntries(Object.entries(value))
    const endpoint = parseEndpoint(
      typeof candidate.endpoint === "string" ? candidate.endpoint : null
    )
    return endpoint &&
      typeof candidate.sessionId === "string" &&
      typeof candidate.subject === "string" &&
      typeof candidate.deviceId === "string" &&
      typeof candidate.generation === "number" &&
      typeof candidate.expiresAt === "number"
      ? {
          endpoint,
          sessionId: candidate.sessionId,
          subject: candidate.subject,
          deviceId: candidate.deviceId,
          generation: candidate.generation,
          expiresAt: candidate.expiresAt
        }
      : null
  }

  private prune(nowSeconds: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM encrypted_envelopes WHERE created_at <= ?",
      nowSeconds - TUNNEL_POLICY.retentionSeconds
    )
    const count = this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM encrypted_envelopes")
      .one().count
    const overflow = count - TUNNEL_POLICY.maxStoredEnvelopes
    if (overflow > 0) {
      this.ctx.storage.sql.exec(
        `DELETE FROM encrypted_envelopes WHERE rowid IN
         (SELECT rowid FROM encrypted_envelopes ORDER BY created_at ASC, sender ASC, sequence ASC LIMIT ?)`,
        overflow
      )
      deviceRelayTelemetry(
        "replay_truncation",
        {
          droppedEnvelopes: overflow,
          reason: "retention-bound",
          sessionId: this.metadata()?.session_id ?? null
        },
        "warn"
      )
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const socketExpiries = this.ctx
      .getWebSockets()
      .map((socket) => this.readAttachment(socket)?.expiresAt)
      .filter((expiresAt): expiresAt is number => typeof expiresAt === "number")
    const oldestEnvelope = this.ctx.storage.sql
      .exec<{ readonly [key: string]: SqlStorageValue; readonly created_at: number | null }>(
        "SELECT MIN(created_at) AS created_at FROM encrypted_envelopes"
      )
      .one().created_at
    const expiries = [
      ...socketExpiries,
      ...(oldestEnvelope === null ? [] : [oldestEnvelope + TUNNEL_POLICY.retentionSeconds])
    ]
    if (expiries.length === 0) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    await this.ctx.storage.setAlarm(Math.min(...expiries) * 1_000)
  }
}
