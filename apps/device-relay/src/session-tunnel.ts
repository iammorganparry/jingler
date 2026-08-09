import type {
  ClientAttachment,
  ControllerLease,
  EncryptedTunnelEnvelope,
  RemoteSessionInventoryEntry,
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

interface ClientAttachmentRow {
  readonly [key: string]: SqlStorageValue
  readonly attachment_id: string
  readonly client_instance_id: string
  readonly mode: "passive" | "controller"
  readonly generation: number
  readonly controller_lease_generation: number
  readonly attached_at: number
  readonly expires_at: number
}

interface ControllerLeaseRow {
  readonly [key: string]: SqlStorageValue
  readonly owner_client_instance_id: string | null
  readonly generation: number
  readonly acquired_at: number | null
  readonly expires_at: number | null
}

export interface TunnelSocketAttachment {
  readonly endpoint: TunnelEndpoint
  readonly sessionId: string
  readonly subject: string
  readonly deviceId: string
  readonly generation: number
  readonly clientInstanceId: string
  readonly attachmentGeneration: number
  readonly controllerLeaseGeneration: number
  readonly expiresAt: number
  /** Added in relay usage v2; absent on hibernated sockets accepted before deployment. */
  readonly usageAttachmentId?: string
  /** Reserved account budget that survives Durable Object hibernation. */
  readonly remainingTransferBytes?: number
}

export interface AttachmentAdmission {
  readonly subject: string
  readonly deviceId: string
  readonly sessionId: string
  readonly clientInstanceId: string
  readonly attachmentGeneration: number
  readonly controllerLeaseGeneration: number
  readonly expiresAt: number
}

export type TunnelConnectionPreparation =
  | { readonly status: "prepared"; readonly controllerLeaseGeneration: number }
  | {
      readonly status:
        | "resource-mismatch"
        | "scope-mismatch"
        | "offline"
        | "stale-attachment"
        | "stale-controller"
        | "controller-occupied"
    }

export type ClientAttachmentResult =
  | { readonly status: "attached"; readonly attachment: ClientAttachment }
  | { readonly status: "scope-mismatch" | "stale-attachment" | "stale-controller" }

export type ControllerLeaseResult =
  | { readonly status: "acquired" | "released"; readonly lease: ControllerLease }
  | {
      readonly status:
        | "scope-mismatch"
        | "offline"
        | "stale-attachment"
        | "stale-controller"
        | "controller-occupied"
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
  | {
      readonly status:
        | "invalid-envelope"
        | "stale-attachment"
        | "stale-controller"
        | "passive-attachment"
    }

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

const base64UrlBytes = (value: string): number => Math.floor((value.length * 3) / 4)

/** One encrypted, replayable, hibernating bidirectional stream per remote session. */
export class SessionTunnelObject extends DurableObject<Env> {
  private metadataCache: TunnelMetadataRow | null | undefined
  private envelopeCountCache: number | null = null
  private scheduledAlarmAt: number | null | undefined
  private readonly newestSequenceCache = new Map<TunnelEndpoint, number>()
  private readonly acknowledgementCache = new Map<TunnelEndpoint, number>()
  private readonly transferMeters = new WeakMap<WebSocket, Promise<void>>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
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
        CREATE TABLE IF NOT EXISTS acknowledgements (
          endpoint TEXT PRIMARY KEY CHECK (endpoint IN ('desktop', 'device')),
          acknowledged_sequence INTEGER NOT NULL CHECK (acknowledged_sequence >= 0),
          seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tunnel_revocations (
          device_id TEXT PRIMARY KEY,
          revoked_generation INTEGER NOT NULL,
          revoked_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS client_attachments (
          client_instance_id TEXT PRIMARY KEY,
          attachment_id TEXT NOT NULL UNIQUE,
          mode TEXT NOT NULL CHECK (mode IN ('passive', 'controller')),
          generation INTEGER NOT NULL CHECK (generation > 0),
          controller_lease_generation INTEGER NOT NULL CHECK (controller_lease_generation > 0),
          attached_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS client_attachments_expiry
          ON client_attachments(expires_at);
        CREATE TABLE IF NOT EXISTS controller_lease (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_client_instance_id TEXT,
          generation INTEGER NOT NULL CHECK (generation > 0),
          acquired_at INTEGER,
          expires_at INTEGER
        );
        INSERT OR IGNORE INTO controller_lease
          (singleton, owner_client_instance_id, generation, acquired_at, expires_at)
          VALUES (1, NULL, 1, NULL, NULL);
        CREATE TABLE IF NOT EXISTS tunnel_counters (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          envelope_count INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO tunnel_counters (singleton) VALUES (1);
      `)
      const cursorMigration = this.ctx.storage.sql
        .exec<{ readonly id: number }>(
          "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1) RETURNING id"
        )
        .toArray()[0]
      if (cursorMigration) {
        // Existing objects created before sequence_cursors need one backfill.
        // Guarding it with a durable migration marker prevents two full-table
        // aggregation reads every time a hibernated object is reactivated.
        this.ctx.storage.sql.exec(`
          INSERT OR IGNORE INTO sequence_cursors (sender, sequence)
            SELECT sender, MAX(sequence) FROM encrypted_envelopes GROUP BY sender;
          INSERT INTO sequence_cursors (sender, sequence)
            SELECT CASE endpoint WHEN 'desktop' THEN 'device' ELSE 'desktop' END,
                   acknowledged_sequence
            FROM acknowledgements
            WHERE true
            ON CONFLICT(sender) DO UPDATE SET
              sequence = MAX(sequence_cursors.sequence, excluded.sequence);
        `)
      }
      const counterMigration = this.ctx.storage.sql
        .exec<{ readonly id: number }>(
          "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (2) RETURNING id"
        )
        .toArray()[0]
      if (counterMigration) {
        this.ctx.storage.sql.exec(`
          UPDATE tunnel_counters SET
            envelope_count = (SELECT COUNT(*) FROM encrypted_envelopes)
          WHERE singleton = 1;
        `)
      }
      const unusedMutationMigration = this.ctx.storage.sql
        .exec<{ readonly id: number }>(
          "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (3) RETURNING id"
        )
        .toArray()[0]
      if (unusedMutationMigration) {
        this.ctx.storage.sql.exec("DROP TABLE IF EXISTS processed_mutations")
      }
    })
  }

  async schemaVersion(): Promise<number> {
    return 1
  }

  async initialize(
    input: TunnelInitialization,
    nowSeconds = Math.floor(Date.now() / 1_000),
    scheduleAlarm = true
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
      this.metadataCache = {
        session_id: input.sessionId,
        subject: input.subject,
        device_id: input.deviceId,
        device_generation: input.deviceGeneration,
        expires_at: input.expiresAt
      }
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
      this.metadataCache = {
        ...existing,
        device_generation: Math.max(existing.device_generation, input.deviceGeneration),
        expires_at: Math.max(existing.expires_at, input.expiresAt)
      }
    }
    if (scheduleAlarm) await this.scheduleAlarm()
    return true
  }

  async attachClient(
    input: AttachmentAdmission,
    nowSeconds = Math.floor(Date.now() / 1_000),
    scheduleAlarm = true
  ): Promise<ClientAttachmentResult> {
    if (!this.matchesAdmission(input)) return { status: "scope-mismatch" }
    const lease = this.normalizedLease(nowSeconds)
    if (input.controllerLeaseGeneration !== lease.generation) {
      return { status: "stale-controller" }
    }
    const existing = this.attachmentRow(input.clientInstanceId)
    if (
      existing &&
      (input.attachmentGeneration < existing.generation ||
        input.attachmentGeneration > existing.generation + 1)
    ) {
      return { status: "stale-attachment" }
    }
    if (!existing && input.attachmentGeneration !== 1) {
      return { status: "stale-attachment" }
    }
    const attachmentId =
      existing?.attachment_id ?? `attachment_${crypto.randomUUID()}`
    const attachedAt = existing?.attached_at ?? nowSeconds
    this.ctx.storage.sql.exec(
      `INSERT INTO client_attachments (
         client_instance_id, attachment_id, mode, generation,
         controller_lease_generation, attached_at, expires_at
       ) VALUES (?, ?, 'passive', ?, ?, ?, ?)
       ON CONFLICT(client_instance_id) DO UPDATE SET
         generation = excluded.generation,
         controller_lease_generation = excluded.controller_lease_generation,
         expires_at = MAX(client_attachments.expires_at, excluded.expires_at)`,
      input.clientInstanceId,
      attachmentId,
      input.attachmentGeneration,
      input.controllerLeaseGeneration,
      attachedAt,
      input.expiresAt
    )
    if (scheduleAlarm) await this.scheduleAlarm()
    return {
      status: "attached",
      attachment: this.clientAttachment(input.clientInstanceId)!
    }
  }

  async acquireController(
    input: AttachmentAdmission & {
      readonly expectedGeneration: number
      readonly takeover: boolean
    },
    nowSeconds = Math.floor(Date.now() / 1_000),
    scheduleAlarm = true
  ): Promise<ControllerLeaseResult> {
    if (!this.matchesAdmission(input)) return { status: "scope-mismatch" }
    const attachment = this.attachmentRow(input.clientInstanceId)
    if (
      !attachment ||
      attachment.expires_at <= nowSeconds ||
      attachment.generation !== input.attachmentGeneration
    ) {
      return { status: attachment ? "stale-attachment" : "offline" }
    }
    const lease = this.normalizedLease(nowSeconds)
    if (
      input.expectedGeneration !== lease.generation ||
      input.controllerLeaseGeneration !== lease.generation
    ) {
      return { status: "stale-controller" }
    }
    if (
      lease.owner_client_instance_id &&
      lease.owner_client_instance_id !== input.clientInstanceId &&
      !input.takeover
    ) {
      return { status: "controller-occupied" }
    }
    const generation =
      lease.owner_client_instance_id &&
      lease.owner_client_instance_id !== input.clientInstanceId
        ? lease.generation + 1
        : lease.generation
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE controller_lease SET owner_client_instance_id = ?, generation = ?,
         acquired_at = ?, expires_at = ? WHERE singleton = 1`,
        input.clientInstanceId,
        generation,
        nowSeconds,
        input.expiresAt
      )
      this.ctx.storage.sql.exec(
        `UPDATE client_attachments SET
           mode = CASE WHEN client_instance_id = ? THEN 'controller' ELSE 'passive' END,
           controller_lease_generation = ?`,
        input.clientInstanceId,
        generation
      )
    })
    if (generation !== lease.generation) {
      this.closeStaleControllerSockets(generation)
    }
    if (scheduleAlarm) await this.scheduleAlarm()
    return { status: "acquired", lease: this.controllerLease(nowSeconds) }
  }

  /**
   * Performs the idempotent tunnel setup in one RPC session and schedules one
   * alarm. Calling these steps separately multiplied both DO requests and
   * alarm row writes for every reconnect.
   */
  async prepareConnection(
    input: {
      readonly endpoint: TunnelEndpoint
      readonly initialization: TunnelInitialization
      readonly admission: AttachmentAdmission
    },
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<TunnelConnectionPreparation> {
    let result: TunnelConnectionPreparation
    const initialized = await this.initialize(input.initialization, nowSeconds, false)
    if (!initialized) {
      result = { status: "resource-mismatch" }
    } else {
      // A desktop takeover can advance the controller generation after the
      // signed grant was minted. The device half of the same tunnel does not
      // publish controller commands, so admit it against the current lease
      // while retaining the attachment and scope fences from the grant.
      const effectiveDeviceGeneration = input.endpoint === "device"
        ? this.normalizedLease(nowSeconds).generation
        : input.admission.controllerLeaseGeneration
      const attachment = input.endpoint === "desktop"
        ? await this.attachClient(input.admission, nowSeconds, false)
        : await this.assertAttachment({
            ...input.admission,
            controllerLeaseGeneration: effectiveDeviceGeneration
          }, nowSeconds)
      if (
        ("status" in attachment && attachment.status !== "attached") ||
        ("active" in attachment && !attachment.active)
      ) {
        result = {
          status: "status" in attachment ? attachment.status : attachment.reason
        }
      } else if (input.endpoint === "desktop") {
        const lease = await this.acquireController({
          ...input.admission,
          expectedGeneration: input.admission.controllerLeaseGeneration,
          takeover: true
        }, nowSeconds, false)
        result = lease.status === "acquired"
          ? {
              status: "prepared",
              controllerLeaseGeneration: lease.lease.generation
            }
          : {
              status: lease.status === "released"
                ? "stale-controller"
                : lease.status
            }
      } else {
        result = {
          status: "prepared",
          controllerLeaseGeneration: effectiveDeviceGeneration
        }
      }
    }
    await this.scheduleAlarm()
    return result
  }

  async releaseController(
    input: AttachmentAdmission & { readonly expectedGeneration: number },
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<ControllerLeaseResult> {
    if (!this.matchesAdmission(input)) return { status: "scope-mismatch" }
    const attachment = this.attachmentRow(input.clientInstanceId)
    if (!attachment || attachment.generation !== input.attachmentGeneration) {
      return { status: attachment ? "stale-attachment" : "offline" }
    }
    const lease = this.normalizedLease(nowSeconds)
    if (
      input.expectedGeneration !== lease.generation ||
      input.controllerLeaseGeneration !== lease.generation ||
      lease.owner_client_instance_id !== input.clientInstanceId
    ) {
      return { status: "stale-controller" }
    }
    const generation = lease.generation + 1
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE controller_lease SET owner_client_instance_id = NULL,
         generation = ?, acquired_at = NULL, expires_at = NULL WHERE singleton = 1`,
        generation
      )
      this.ctx.storage.sql.exec(
        `UPDATE client_attachments SET mode = 'passive',
         controller_lease_generation = ?`,
        generation
      )
    })
    this.closeStaleControllerSockets(generation)
    await this.scheduleAlarm()
    return { status: "released", lease: this.controllerLease(nowSeconds) }
  }

  async assertAttachment(
    input: AttachmentAdmission,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<
    | { readonly active: true; readonly attachment: ClientAttachment }
    | { readonly active: false; readonly reason: "scope-mismatch" | "offline" | "stale-attachment" | "stale-controller" }
  > {
    if (!this.matchesAdmission(input)) {
      return { active: false, reason: "scope-mismatch" }
    }
    const row = this.attachmentRow(input.clientInstanceId)
    if (!row || row.expires_at <= nowSeconds) {
      return { active: false, reason: "offline" }
    }
    if (row.generation !== input.attachmentGeneration) {
      return { active: false, reason: "stale-attachment" }
    }
    const lease = this.normalizedLease(nowSeconds)
    if (lease.generation !== input.controllerLeaseGeneration) {
      return { active: false, reason: "stale-controller" }
    }
    return { active: true, attachment: this.clientAttachment(input.clientInstanceId)! }
  }

  async inventoryEntry(
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<RemoteSessionInventoryEntry | null> {
    const metadata = this.metadata()
    if (!metadata) return null
    const lease = this.normalizedLease(nowSeconds)
    return {
      version: 1,
      sessionId: metadata.session_id,
      state: this.ctx.getWebSockets().length > 0 ? "running" : "idle",
      controllerClientInstanceId: lease.owner_client_instance_id,
      controllerLeaseGeneration: lease.generation,
      updatedAt: nowSeconds
    }
  }

  async inventoryEntryFor(
    subject: string,
    deviceId: string,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<RemoteSessionInventoryEntry | null> {
    const metadata = this.metadata()
    return metadata?.subject === subject && metadata.device_id === deviceId
      ? this.inventoryEntry(nowSeconds)
      : null
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
    const clientInstanceId = request.headers.get("x-jingler-client-instance-id")
    const attachmentGeneration = parseInteger(
      request.headers.get("x-jingler-attachment-generation")
    )
    const controllerLeaseGeneration = parseInteger(
      request.headers.get("x-jingler-controller-lease-generation")
    )
    const expiresAt = parseInteger(request.headers.get("x-jingler-expires-at"))
    const usageAttachmentId =
      request.headers.get("x-jingler-usage-attachment-id") ??
      `legacy:${sessionId ?? "unknown"}:${endpoint ?? "unknown"}:${clientInstanceId ?? "unknown"}`
    const requestedAcknowledgement =
      parseInteger(request.headers.get("x-jingler-acknowledged-sequence")) ?? 0
    const metadata = this.metadata()
    const nowSeconds = Math.floor(Date.now() / 1_000)
    if (
      !endpoint ||
      !sessionId ||
      !subject ||
      !deviceId ||
      !clientInstanceId ||
      generation === null ||
      attachmentGeneration === null ||
      controllerLeaseGeneration === null ||
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
    const attachment = await this.assertAttachment(
      {
        subject,
        deviceId,
        sessionId,
        clientInstanceId,
        attachmentGeneration,
        controllerLeaseGeneration,
        expiresAt
      },
      nowSeconds
    )
    if (!attachment.active) {
      return Response.json(
        { error: attachment.reason },
        { status: attachment.reason === "offline" ? 409 : 403 }
      )
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
      clientInstanceId,
      attachmentGeneration,
      controllerLeaseGeneration,
      expiresAt,
      usageAttachmentId,
      remainingTransferBytes: 0
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
        const metered = await this.meterTransfer(
          socket,
          attachment,
          base64UrlBytes(message.envelope.ciphertext)
        )
        if (metered !== "recorded") {
          safeSend(socket, { type: "error", code: metered })
          safeClose(socket, 4008, "Relay quota exceeded")
          return
        }
        const result = this.publishAuthorizedEnvelope(attachment, message.envelope)
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
    const attachment = this.readAttachment(socket)
    if (attachment?.usageAttachmentId) {
      await this.env.RELAY_USAGE.getByName(attachment.subject).release(
        attachment.usageAttachmentId,
        attachment.deviceId,
        attachment.remainingTransferBytes ?? 0
      )
    }
    safeClose(socket, code, reason)
    await this.scheduleAlarm()
  }

  override async alarm(): Promise<void> {
    this.scheduledAlarmAt = null
    const nowSeconds = Math.floor(Date.now() / 1_000)
    this.normalizedLease(nowSeconds)
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(socket)
      const client = attachment
        ? this.attachmentRow(attachment.clientInstanceId)
        : null
      if (
        !attachment ||
        attachment.expiresAt <= nowSeconds ||
        !client ||
        client.expires_at <= nowSeconds
      ) {
        safeClose(socket, 4001, "Tunnel grant expired")
      }
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM client_attachments WHERE expires_at <= ?",
      nowSeconds
    )
    this.pruneExpired(nowSeconds)
    this.pruneCapacity()
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
      this.ctx.storage.sql.exec(
        `UPDATE tunnel_counters SET envelope_count = envelope_count + 1
         WHERE singleton = 1`
      )
    })
    this.envelopeCountCache =
      this.envelopeCountCache === null
        ? this.countEnvelopes()
        : this.envelopeCountCache + 1
    this.newestSequenceCache.set(endpoint, normalized.sequence)
    for (const socket of this.ctx.getWebSockets(`endpoint:${opposite(endpoint)}`)) {
      safeSend(socket, { type: "envelope", envelope: normalized })
    }
    this.pruneCapacity()
    return { status: "inserted", sequence: normalized.sequence }
  }

  /** Applies the controller lease to the established encrypted command path. */
  publishAuthorizedEnvelope(
    attachment: TunnelSocketAttachment,
    envelope: EncryptedTunnelEnvelope,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): PublishEnvelopeResult {
    if (attachment.endpoint === "device") {
      return this.publishEnvelope("device", envelope)
    }
    const client = this.attachmentRow(attachment.clientInstanceId)
    if (
      !client ||
      client.expires_at <= nowSeconds ||
      client.generation !== attachment.attachmentGeneration
    ) {
      return { status: "stale-attachment" }
    }
    const lease = this.normalizedLease(nowSeconds)
    if (
      lease.owner_client_instance_id !== attachment.clientInstanceId ||
      lease.generation !== attachment.controllerLeaseGeneration
    ) {
      return { status: "stale-controller" }
    }
    if (client.mode !== "controller") return { status: "passive-attachment" }
    return this.publishEnvelope("desktop", envelope)
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
      const deleted = this.ctx.storage.sql.exec<SequenceRow>(
        `DELETE FROM encrypted_envelopes WHERE sender = ? AND sequence <= ?
         RETURNING sequence`,
        source,
        acknowledged
      ).toArray().length
      if (deleted > 0) {
        this.ctx.storage.sql.exec(
          `UPDATE tunnel_counters SET
             envelope_count = MAX(0, envelope_count - ?)
           WHERE singleton = 1`,
          deleted
        )
      }
      if (this.envelopeCountCache !== null) {
        this.envelopeCountCache = Math.max(0, this.envelopeCountCache - deleted)
      }
    })
    this.acknowledgementCache.set(endpoint, acknowledged)
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
    return this.countEnvelopes()
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
    if (this.metadataCache !== undefined) return this.metadataCache
    this.metadataCache =
      this.ctx.storage.sql.exec<TunnelMetadataRow>(
        `SELECT session_id, subject, device_id, device_generation, expires_at
         FROM tunnel_metadata LIMIT 1`
      ).toArray()[0] ?? null
    return this.metadataCache
  }

  private matchesAdmission(input: AttachmentAdmission): boolean {
    const metadata = this.metadata()
    return Boolean(
      metadata &&
        metadata.subject === input.subject &&
        metadata.device_id === input.deviceId &&
        metadata.session_id === input.sessionId
    )
  }

  private attachmentRow(clientInstanceId: string): ClientAttachmentRow | null {
    return (
      this.ctx.storage.sql
        .exec<ClientAttachmentRow>(
          `SELECT attachment_id, client_instance_id, mode, generation,
                  controller_lease_generation, attached_at, expires_at
           FROM client_attachments WHERE client_instance_id = ?`,
          clientInstanceId
        )
        .toArray()[0] ?? null
    )
  }

  private clientAttachment(clientInstanceId: string): ClientAttachment | null {
    const metadata = this.metadata()
    const row = this.attachmentRow(clientInstanceId)
    if (!metadata || !row) return null
    return {
      version: 1,
      attachmentId: row.attachment_id,
      subject: metadata.subject,
      deviceId: metadata.device_id,
      sessionId: metadata.session_id,
      clientInstanceId: row.client_instance_id,
      mode: row.mode,
      generation: row.generation,
      controllerLeaseGeneration: row.controller_lease_generation,
      attachedAt: row.attached_at,
      expiresAt: row.expires_at
    }
  }

  private leaseRow(): ControllerLeaseRow {
    return this.ctx.storage.sql
      .exec<ControllerLeaseRow>(
        `SELECT owner_client_instance_id, generation, acquired_at, expires_at
         FROM controller_lease WHERE singleton = 1`
      )
      .one()
  }

  private normalizedLease(nowSeconds: number): ControllerLeaseRow {
    const lease = this.leaseRow()
    if (
      !lease.owner_client_instance_id ||
      lease.expires_at === null ||
      lease.expires_at > nowSeconds
    ) {
      return lease
    }
    const generation = lease.generation + 1
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE controller_lease SET owner_client_instance_id = NULL,
         generation = ?, acquired_at = NULL, expires_at = NULL
         WHERE singleton = 1 AND generation = ?`,
        generation,
        lease.generation
      )
      this.ctx.storage.sql.exec(
        `UPDATE client_attachments SET mode = 'passive',
         controller_lease_generation = ?`,
        generation
      )
    })
    this.closeStaleControllerSockets(generation)
    return this.leaseRow()
  }

  private controllerLease(nowSeconds: number): ControllerLease {
    const metadata = this.metadata()
    if (!metadata) throw new Error("Tunnel is not initialized")
    const row = this.normalizedLease(nowSeconds)
    return {
      version: 1,
      subject: metadata.subject,
      deviceId: metadata.device_id,
      sessionId: metadata.session_id,
      ownerClientInstanceId: row.owner_client_instance_id,
      generation: row.generation,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at
    }
  }

  private closeStaleControllerSockets(generation: number): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(socket)
      if (
        attachment &&
        attachment.controllerLeaseGeneration !== generation
      ) {
        safeClose(socket, 4004, "Controller generation changed")
      }
    }
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
    const cached = this.newestSequenceCache.get(sender)
    if (cached !== undefined) return cached
    const sequence =
      this.ctx.storage.sql
        .exec<SequenceRow>("SELECT sequence FROM sequence_cursors WHERE sender = ?", sender)
        .toArray()[0]?.sequence ?? 0
    this.newestSequenceCache.set(sender, sequence)
    return sequence
  }

  private acknowledgedSequence(endpoint: TunnelEndpoint): number {
    const cached = this.acknowledgementCache.get(endpoint)
    if (cached !== undefined) return cached
    const sequence =
      this.ctx.storage.sql
        .exec<AcknowledgementRow>(
          "SELECT acknowledged_sequence FROM acknowledgements WHERE endpoint = ?",
          endpoint
        )
        .toArray()[0]?.acknowledged_sequence ?? 0
    this.acknowledgementCache.set(endpoint, sequence)
    return sequence
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
    // Revocation and controller changes proactively close tagged sockets. The
    // mutating publish paths still re-check their durable generation fence;
    // avoiding the same three reads here keeps every encrypted frame lean.
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
      typeof candidate.clientInstanceId === "string" &&
      typeof candidate.attachmentGeneration === "number" &&
      typeof candidate.controllerLeaseGeneration === "number" &&
      typeof candidate.expiresAt === "number" &&
      (candidate.usageAttachmentId === undefined ||
        typeof candidate.usageAttachmentId === "string") &&
      (candidate.remainingTransferBytes === undefined ||
        (typeof candidate.remainingTransferBytes === "number" &&
          Number.isSafeInteger(candidate.remainingTransferBytes) &&
          candidate.remainingTransferBytes >= 0))
      ? {
          endpoint,
          sessionId: candidate.sessionId,
          subject: candidate.subject,
          deviceId: candidate.deviceId,
          generation: candidate.generation,
          clientInstanceId: candidate.clientInstanceId,
          attachmentGeneration: candidate.attachmentGeneration,
          controllerLeaseGeneration: candidate.controllerLeaseGeneration,
          expiresAt: candidate.expiresAt,
          remainingTransferBytes:
            typeof candidate.remainingTransferBytes === "number"
              ? candidate.remainingTransferBytes
              : 0,
          ...(typeof candidate.usageAttachmentId === "string"
            ? { usageAttachmentId: candidate.usageAttachmentId }
            : {})
        }
      : null
  }

  private async meterTransfer(
    socket: WebSocket,
    attachment: TunnelSocketAttachment,
    bytes: number
  ): Promise<"recorded" | "quota-exceeded" | "invalid-frame"> {
    const previous = this.transferMeters.get(socket) ?? Promise.resolve()
    const metered = previous.catch(() => undefined).then(async () => {
      const current = this.attachment(socket) ?? attachment
      let remaining = current.remainingTransferBytes ?? 0
      if (remaining < bytes) {
        const reservation = await this.env.RELAY_USAGE.getByName(
          current.subject
        ).reserveTransfer(current.deviceId, bytes)
        if (reservation.status !== "reserved") return reservation.status
        remaining += reservation.bytes
      }
      socket.serializeAttachment({
        ...current,
        remainingTransferBytes: remaining - bytes
      } satisfies TunnelSocketAttachment)
      return "recorded" as const
    })
    this.transferMeters.set(socket, metered.then(() => undefined, () => undefined))
    return metered
  }

  private countEnvelopes(): number {
    return this.ctx.storage.sql
      .exec<CountRow>(
        "SELECT envelope_count AS count FROM tunnel_counters WHERE singleton = 1"
      )
      .one().count
  }

  private pruneExpired(nowSeconds: number): void {
    const deletedEnvelopes = this.ctx.storage.transactionSync(() => {
      const deletedEnvelopes = this.ctx.storage.sql.exec<SequenceRow>(
        `DELETE FROM encrypted_envelopes WHERE created_at <= ?
         RETURNING sequence`,
        nowSeconds - TUNNEL_POLICY.retentionSeconds
      ).toArray().length
      if (deletedEnvelopes > 0) {
        this.ctx.storage.sql.exec(
          `UPDATE tunnel_counters SET
             envelope_count = MAX(0, envelope_count - ?)
           WHERE singleton = 1`,
          deletedEnvelopes
        )
      }
      return deletedEnvelopes
    })
    this.envelopeCountCache =
      this.envelopeCountCache === null
        ? this.countEnvelopes()
        : Math.max(0, this.envelopeCountCache - deletedEnvelopes)
  }

  private pruneCapacity(): void {
    const envelopeCount = this.envelopeCountCache ?? this.countEnvelopes()
    this.envelopeCountCache = envelopeCount
    const overflow = envelopeCount - TUNNEL_POLICY.maxStoredEnvelopes
    if (overflow > 0) {
      const deleted = this.ctx.storage.transactionSync(() => {
        const deleted = this.ctx.storage.sql.exec<SequenceRow>(
          `DELETE FROM encrypted_envelopes WHERE rowid IN
           (SELECT rowid FROM encrypted_envelopes
            ORDER BY created_at ASC, sender ASC, sequence ASC LIMIT ?)
           RETURNING sequence`,
          overflow
        ).toArray().length
        if (deleted > 0) {
          this.ctx.storage.sql.exec(
            `UPDATE tunnel_counters SET
               envelope_count = MAX(0, envelope_count - ?)
             WHERE singleton = 1`,
            deleted
          )
        }
        return deleted
      })
      this.envelopeCountCache = Math.max(0, envelopeCount - deleted)
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
    const attachmentExpiry = this.ctx.storage.sql
      .exec<{
        readonly [key: string]: SqlStorageValue
        readonly expires_at: number | null
      }>("SELECT MIN(expires_at) AS expires_at FROM client_attachments")
      .one().expires_at
    const leaseExpiry = this.ctx.storage.sql
      .exec<ControllerLeaseRow>(
        "SELECT expires_at FROM controller_lease WHERE singleton = 1"
      )
      .one().expires_at
    const expiries = [
      ...socketExpiries,
      ...(oldestEnvelope === null
        ? []
        : [oldestEnvelope + TUNNEL_POLICY.retentionSeconds]),
      ...(attachmentExpiry === null ? [] : [attachmentExpiry]),
      ...(leaseExpiry === null ? [] : [leaseExpiry])
    ]
    if (expiries.length === 0) {
      const current = this.scheduledAlarmAt === undefined
        ? await this.ctx.storage.getAlarm()
        : this.scheduledAlarmAt
      if (current !== null) await this.ctx.storage.deleteAlarm()
      this.scheduledAlarmAt = null
      return
    }
    const next = Math.min(...expiries) * 1_000
    const current = this.scheduledAlarmAt === undefined
      ? await this.ctx.storage.getAlarm()
      : this.scheduledAlarmAt
    if (current !== next) await this.ctx.storage.setAlarm(next)
    this.scheduledAlarmAt = next
  }
}
