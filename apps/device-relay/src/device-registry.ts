import type {
  DeviceChallenge,
  DeviceListResponse,
  DevicePublicKey,
  DeviceEncryptionPublicKey,
  PendingDeviceRegistrationRequest,
  PendingDeviceRegistrationResponse,
  RemoteDevice,
  RemoteDeviceDiscovery,
  RemoteDeviceCapabilities,
  RemoteDevicePlatform
} from "@jingler/core"
import {
  DeviceControlClientMessage,
  DevicePublicKey as DevicePublicKeySchema,
  DeviceEncryptionPublicKey as DeviceEncryptionPublicKeySchema,
  RemoteDeviceCapabilities as RemoteDeviceCapabilitiesSchema,
  RemoteDeviceDiscovery as RemoteDeviceDiscoverySchema,
  RemoteDevicePlatform as RemoteDevicePlatformSchema,
  deviceChallengePayload
} from "@jingler/core"
import { DurableObject } from "cloudflare:workers"
import { Schema } from "effect"
import { deviceRelayTelemetry } from "./telemetry.js"

export { deviceChallengePayload } from "@jingler/core"

const PAIRING_TTL_SECONDS = 10 * 60
const CHALLENGE_TTL_SECONDS = 2 * 60
const MAX_PAIRING_ATTEMPTS = 5
const MAX_AUDIT_RECORDS = 500
const MAX_DEVICE_SESSIONS = 64
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const encoder = new TextEncoder()

interface PendingDeviceRow {
  readonly [key: string]: SqlStorageValue
  readonly pending_device_id: string
  readonly device_id: string
  readonly pairing_hash: string
  readonly display_name: string
  readonly platform_json: string
  readonly public_key_json: string
  readonly encryption_public_key_json: string | null
  readonly capabilities_json: string
  readonly created_at: number
  readonly expires_at: number
  readonly failed_attempts: number
  readonly claimed_subject: string | null
  readonly claimed_at: number | null
}

interface DeviceRow {
  readonly [key: string]: SqlStorageValue
  readonly device_id: string
  readonly display_name: string
  readonly platform_json: string
  readonly public_key_json: string
  readonly encryption_public_key_json: string | null
  readonly capabilities_json: string
  readonly state: "active" | "revoked"
  readonly generation: number
  readonly created_at: number
  readonly updated_at: number
}

interface PresenceRow {
  readonly [key: string]: SqlStorageValue
  readonly state: "online" | "offline"
  readonly connected_at: number | null
  readonly last_seen_at: number | null
}

interface SessionRow {
  readonly [key: string]: SqlStorageValue
  readonly session_id: string
}

interface MetadataRow {
  readonly [key: string]: SqlStorageValue
  readonly value: string
}

interface DiscoveryRow {
  readonly [key: string]: SqlStorageValue
  readonly discovery_json: string
  readonly updated_at: number
}

interface ChallengeRow {
  readonly [key: string]: SqlStorageValue
  readonly challenge_id: string
  readonly device_id: string
  readonly nonce_hash: string
  readonly purpose: "connect" | "rotate-key"
  readonly issued_at: number
  readonly expires_at: number
  readonly consumed_at: number | null
}

interface CountRow {
  readonly [key: string]: SqlStorageValue
  readonly count: number
}

interface DeviceSocketAttachment {
  readonly deviceId: string
  readonly generation: number
  readonly expiresAt: number
}

export interface ClaimedPendingDevice {
  readonly pendingDeviceId: string
  readonly deviceId: string
  readonly claimedSubject: string
  readonly displayName: string
  readonly platform: RemoteDevicePlatform
  readonly publicKey: DevicePublicKey
  readonly encryptionPublicKey?: DeviceEncryptionPublicKey
  readonly capabilities: RemoteDeviceCapabilities
  readonly createdAt: number
}

export type PairingClaimResult =
  | { readonly status: "claimed"; readonly device: ClaimedPendingDevice }
  | {
      readonly status:
        | "not-found"
        | "expired"
        | "invalid-code"
        | "rate-limited"
        | "already-claimed"
    }

export type DeviceChallengeResult =
  | {
      readonly status: "verified"
      readonly subject: string
      readonly deviceId: string
      readonly generation: number
    }
  | {
      readonly status:
        | "not-found"
        | "revoked"
        | "expired"
        | "replayed"
        | "invalid-challenge"
        | "invalid-signature"
    }

const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const randomBytes = (length: number): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(length))

export const randomOpaqueId = (prefix: string): string =>
  `${prefix}_${base64Url(randomBytes(18))}`

export const randomPairingCode = (): string => {
  const bytes = randomBytes(8)
  return [...bytes].map((byte) => PAIRING_ALPHABET[byte & 31]).join("")
}

const sha256 = async (value: string): Promise<string> =>
  base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
  )

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  let difference = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return difference === 0
}

const decodeJson = <A, I>(schema: Schema.Schema<A, I>, value: string): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(value))

const safeSocketClose = (
  socket: WebSocket,
  code: number,
  reason: string
): void => {
  try {
    socket.close(code, reason)
  } catch {
    // The runtime may already consider a hibernated socket closed.
  }
}

/** Per-user authorization state, plus isolated one-row instances for pending pairings. */
export class DeviceRegistryObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS registry_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pending_devices (
          pending_device_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL UNIQUE,
          pairing_hash TEXT NOT NULL,
          display_name TEXT NOT NULL,
          platform_json TEXT NOT NULL,
          public_key_json TEXT NOT NULL,
          encryption_public_key_json TEXT,
          capabilities_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          failed_attempts INTEGER NOT NULL DEFAULT 0,
          claimed_subject TEXT,
          claimed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS pending_devices_expiry ON pending_devices(expires_at);
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          platform_json TEXT NOT NULL,
          public_key_json TEXT NOT NULL,
          encryption_public_key_json TEXT,
          capabilities_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
          generation INTEGER NOT NULL CHECK (generation > 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS device_presence (
          device_id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK (state IN ('online', 'offline')),
          connected_at INTEGER,
          last_seen_at INTEGER,
          FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS device_discovery (
          device_id TEXT PRIMARY KEY,
          discovery_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS device_sessions (
          device_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (device_id, session_id),
          FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS device_challenges (
          challenge_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          nonce_hash TEXT NOT NULL,
          purpose TEXT NOT NULL CHECK (purpose IN ('connect', 'rotate-key')),
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER,
          FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS device_challenges_expiry ON device_challenges(expires_at);
        CREATE TABLE IF NOT EXISTS audit_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event TEXT NOT NULL,
          device_id TEXT,
          occurred_at INTEGER NOT NULL,
          details_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_records_time ON audit_records(occurred_at);
      `)
      // SQLite-backed Durable Objects are long lived. CREATE TABLE IF NOT
      // EXISTS does not add columns to objects created by an older worker, so
      // evolve those objects in place before any request can observe them.
      const pendingColumns = new Set(
        [...this.ctx.storage.sql.exec<{ readonly name: string }>("PRAGMA table_info(pending_devices)")]
          .map((column) => column.name)
      )
      if (!pendingColumns.has("encryption_public_key_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE pending_devices ADD COLUMN encryption_public_key_json TEXT"
        )
      }
      const deviceColumns = new Set(
        [...this.ctx.storage.sql.exec<{ readonly name: string }>("PRAGMA table_info(devices)")]
          .map((column) => column.name)
      )
      if (!deviceColumns.has("encryption_public_key_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE devices ADD COLUMN encryption_public_key_json TEXT"
        )
      }
    })
  }

  async schemaVersion(): Promise<number> {
    return 1
  }

  override async fetch(request: Request): Promise<Response> {
    if (
      request.headers.get("upgrade")?.toLocaleLowerCase("en-US") !== "websocket"
    ) {
      return Response.json(
        { error: "Expected websocket upgrade" },
        { status: 426 }
      )
    }
    const subject = request.headers.get("x-jingler-subject")
    const deviceId = request.headers.get("x-jingler-device-id")
    const generation = Number(
      request.headers.get("x-jingler-device-generation") ?? "0"
    )
    const expiresAt = Number(request.headers.get("x-jingler-expires-at") ?? "0")
    const nowSeconds = Math.floor(Date.now() / 1_000)
    const current = deviceId
      ? await this.assertGeneration(deviceId, generation)
      : { active: false, generation: null }
    if (
      !subject ||
      subject !== this.subject() ||
      !deviceId ||
      !Number.isSafeInteger(generation) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= nowSeconds ||
      !current.active
    ) {
      return Response.json(
        { error: "Device admission rejected" },
        { status: 403 }
      )
    }
    for (const socket of this.ctx.getWebSockets(`device:${deviceId}`)) {
      safeSocketClose(socket, 4002, "Connection replaced")
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, [`device:${deviceId}`])
    server.serializeAttachment({
      deviceId,
      generation,
      expiresAt
    } satisfies DeviceSocketAttachment)
    await this.setPresence(deviceId, generation, "online", nowSeconds)
    server.send(
      JSON.stringify({ type: "hello", version: 1, deviceId, generation })
    )
    await this.scheduleAlarm()
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(
    socket: WebSocket,
    rawMessage: string | ArrayBuffer
  ): Promise<void> {
    const attachment = this.socketAttachment(socket)
    if (!attachment || attachment.expiresAt <= Math.floor(Date.now() / 1_000)) {
      safeSocketClose(socket, 4001, "Device grant expired")
      return
    }
    if (typeof rawMessage !== "string") {
      socket.send(JSON.stringify({ type: "error", code: "invalid-message" }))
      return
    }
    let message: Schema.Schema.Type<typeof DeviceControlClientMessage>
    try {
      message = Schema.decodeUnknownSync(DeviceControlClientMessage)(
        JSON.parse(rawMessage),
        {
          onExcessProperty: "error"
        }
      )
    } catch {
      socket.send(JSON.stringify({ type: "error", code: "invalid-message" }))
      return
    }
    const nowSeconds = Math.floor(Date.now() / 1_000)
    await this.setPresence(
      attachment.deviceId,
      attachment.generation,
      "online",
      nowSeconds
    )
    if (message.type === "announce") {
      this.ctx.storage.sql.exec(
        `INSERT INTO device_discovery (device_id, discovery_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           discovery_json = excluded.discovery_json,
           updated_at = excluded.updated_at`,
        attachment.deviceId,
        JSON.stringify(message.discovery),
        nowSeconds
      )
      this.ctx.storage.sql.exec(
        `UPDATE devices SET capabilities_json = ?, platform_json = ?, updated_at = ?
         WHERE device_id = ? AND generation = ? AND state = 'active'`,
        JSON.stringify(message.discovery.capabilities),
        JSON.stringify(message.discovery.platform),
        nowSeconds,
        attachment.deviceId,
        attachment.generation
      )
      socket.send(JSON.stringify({ type: "announced", at: nowSeconds }))
      return
    }
    socket.send(JSON.stringify({ type: "pong", at: nowSeconds }))
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const attachment = this.socketAttachment(socket)
    safeSocketClose(socket, code, reason)
    if (
      attachment &&
      this.ctx
        .getWebSockets(`device:${attachment.deviceId}`)
        .every((candidate) => candidate === socket)
    ) {
      await this.setPresence(
        attachment.deviceId,
        attachment.generation,
        "offline",
        Math.floor(Date.now() / 1_000)
      )
    }
    await this.scheduleAlarm()
  }

  async initializeSubject(subject: string): Promise<void> {
    const existing = this.subject()
    if (existing && existing !== subject)
      throw new Error("Registry subject mismatch")
    if (!existing) {
      this.ctx.storage.sql.exec(
        "INSERT INTO registry_metadata (key, value) VALUES ('subject', ?)",
        subject
      )
    }
  }

  async registerPending(
    input: {
      readonly pendingDeviceId: string
      readonly deviceId: string
      readonly pairingCode: string
      readonly registration: PendingDeviceRegistrationRequest
    },
    nowSeconds = Math.floor(Date.now() / 1_000),
    ttlSeconds = PAIRING_TTL_SECONDS
  ): Promise<PendingDeviceRegistrationResponse> {
    const expiresAt = nowSeconds + ttlSeconds
    const pairingHash = await sha256(input.pairingCode)
    this.ctx.storage.sql.exec(
      `INSERT INTO pending_devices (
         pending_device_id, device_id, pairing_hash, display_name, platform_json,
         public_key_json, encryption_public_key_json, capabilities_json, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.pendingDeviceId,
      input.deviceId,
      pairingHash,
      input.registration.displayName,
      JSON.stringify(input.registration.platform),
      JSON.stringify(input.registration.publicKey),
      input.registration.encryptionPublicKey ? JSON.stringify(input.registration.encryptionPublicKey) : null,
      JSON.stringify(input.registration.capabilities),
      nowSeconds,
      expiresAt
    )
    await this.scheduleAlarm()
    return {
      version: 1,
      pendingDeviceId: input.pendingDeviceId,
      deviceId: input.deviceId,
      pairingCode: input.pairingCode,
      expiresAt
    }
  }

  async claimPending(
    subject: string,
    pendingDeviceId: string,
    pairingCode: string,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<PairingClaimResult> {
    const row = this.pending(pendingDeviceId)
    if (!row) {
      this.pairingTelemetry("not-found", null, 0)
      return { status: "not-found" }
    }
    if (row.expires_at <= nowSeconds) {
      this.ctx.storage.sql.exec(
        "DELETE FROM pending_devices WHERE pending_device_id = ?",
        pendingDeviceId
      )
      this.audit("pairing-rejected", row.device_id, nowSeconds, {
        reason: "expired"
      })
      this.pairingTelemetry("expired", row.device_id, row.failed_attempts)
      await this.scheduleAlarm()
      return { status: "expired" }
    }
    const suppliedHash = await sha256(pairingCode)
    const matches = constantTimeEqual(row.pairing_hash, suppliedHash)
    if (row.claimed_subject) {
      this.audit("pairing-rejected", row.device_id, nowSeconds, {
        reason: "already-claimed",
        sameSubject: row.claimed_subject === subject,
        validCode: matches
      })
      this.pairingTelemetry(
        "already-claimed",
        row.device_id,
        row.failed_attempts
      )
      return { status: "already-claimed" }
    }
    if (row.failed_attempts >= MAX_PAIRING_ATTEMPTS) {
      this.pairingTelemetry("rate-limited", row.device_id, row.failed_attempts)
      return { status: "rate-limited" }
    }
    if (!matches) {
      this.ctx.storage.sql.exec(
        `UPDATE pending_devices SET failed_attempts = failed_attempts + 1
         WHERE pending_device_id = ? AND claimed_subject IS NULL`,
        pendingDeviceId
      )
      this.audit("pairing-rejected", row.device_id, nowSeconds, {
        reason: "invalid-code"
      })
      this.pairingTelemetry(
        row.failed_attempts + 1 >= MAX_PAIRING_ATTEMPTS
          ? "rate-limited"
          : "invalid-code",
        row.device_id,
        row.failed_attempts + 1
      )
      return {
        status:
          row.failed_attempts + 1 >= MAX_PAIRING_ATTEMPTS
            ? "rate-limited"
            : "invalid-code"
      }
    }

    const claimedRows = this.ctx.storage.sql
      .exec<PendingDeviceRow>(
        `UPDATE pending_devices SET claimed_subject = ?, claimed_at = ?
         WHERE pending_device_id = ? AND claimed_subject IS NULL AND expires_at > ?
         RETURNING *`,
        subject,
        nowSeconds,
        pendingDeviceId,
        nowSeconds
      )
      .toArray()
    const claimedRow = claimedRows[0]
    if (!claimedRow) {
      const concurrent = this.pending(pendingDeviceId)
      this.pairingTelemetry(
        concurrent ? "already-claimed" : "not-found",
        concurrent?.device_id ?? null,
        concurrent?.failed_attempts ?? 0
      )
      return { status: concurrent ? "already-claimed" : "not-found" }
    }
    this.audit("pairing-claimed", claimedRow.device_id, nowSeconds, {})
    this.pairingTelemetry(
      "claimed",
      claimedRow.device_id,
      claimedRow.failed_attempts
    )
    await this.scheduleAlarm()
    return { status: "claimed", device: this.claimed(claimedRow) }
  }

  async adoptClaim(
    subject: string,
    claim: ClaimedPendingDevice,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<RemoteDevice> {
    if (claim.claimedSubject !== subject)
      throw new Error("Pairing subject mismatch")
    await this.initializeSubject(subject)
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO devices (
           device_id, display_name, platform_json, public_key_json, encryption_public_key_json, capabilities_json,
           state, generation, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        claim.deviceId,
        claim.displayName,
        JSON.stringify(claim.platform),
        JSON.stringify(claim.publicKey),
        claim.encryptionPublicKey ? JSON.stringify(claim.encryptionPublicKey) : null,
        JSON.stringify(claim.capabilities),
        claim.createdAt,
        nowSeconds
      )
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO device_presence
         (device_id, state, connected_at, last_seen_at) VALUES (?, 'offline', NULL, NULL)`,
        claim.deviceId
      )
    })
    this.audit("device-paired", claim.deviceId, nowSeconds, {})
    const device = this.device(claim.deviceId)
    if (!device) throw new Error("Claimed device was not persisted")
    return device
  }

  async listDevices(): Promise<DeviceListResponse> {
    const rows = this.ctx.storage.sql
      .exec<DeviceRow>(
        "SELECT * FROM devices ORDER BY created_at ASC, device_id ASC LIMIT 256"
      )
      .toArray()
    return { version: 1, devices: rows.map((row) => this.deviceFromRow(row)) }
  }

  async getDevice(deviceId: string): Promise<RemoteDevice | null> {
    return this.device(deviceId)
  }

  async getDiscovery(deviceId: string): Promise<{
    readonly version: 1
    readonly deviceId: string
    readonly discovery: RemoteDeviceDiscovery | null
    readonly updatedAt: number | null
  } | null> {
    if (!this.device(deviceId)) return null
    const row = this.ctx.storage.sql
      .exec<DiscoveryRow>(
        "SELECT discovery_json, updated_at FROM device_discovery WHERE device_id = ?",
        deviceId
      )
      .toArray()[0]
    return {
      version: 1,
      deviceId,
      discovery: row ? decodeJson(RemoteDeviceDiscoverySchema, row.discovery_json) : null,
      updatedAt: row?.updated_at ?? null
    }
  }

  async assertGeneration(
    deviceId: string,
    generation: number
  ): Promise<{ readonly active: boolean; readonly generation: number | null }> {
    const row = this.deviceRow(deviceId)
    return {
      active: row?.state === "active" && row.generation === generation,
      generation: row?.generation ?? null
    }
  }

  async registerSession(
    deviceId: string,
    generation: number,
    sessionId: string,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<boolean> {
    const current = await this.assertGeneration(deviceId, generation)
    if (!current.active) return false
    const existing = this.ctx.storage.sql
      .exec<CountRow>(
        "SELECT COUNT(*) AS count FROM device_sessions WHERE device_id = ? AND session_id = ?",
        deviceId,
        sessionId
      )
      .one().count
    const sessions = this.ctx.storage.sql
      .exec<CountRow>(
        "SELECT COUNT(*) AS count FROM device_sessions WHERE device_id = ?",
        deviceId
      )
      .one().count
    if (existing === 0 && sessions >= MAX_DEVICE_SESSIONS) return false
    this.ctx.storage.sql.exec(
      `INSERT INTO device_sessions (device_id, session_id, generation, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id, session_id) DO UPDATE SET
         generation = excluded.generation, updated_at = excluded.updated_at`,
      deviceId,
      sessionId,
      generation,
      nowSeconds
    )
    return true
  }

  async notifySession(
    deviceId: string,
    sessionId: string,
    grant: string,
    keyOffer: unknown
  ): Promise<boolean> {
    const sockets = this.ctx.getWebSockets(`device:${deviceId}`)
    if (sockets.length === 0) return false
    for (const socket of sockets) {
      socket.send(JSON.stringify({ type: "session-request", sessionId, grant, keyOffer }))
    }
    return true
  }

  async revokeDevice(
    deviceId: string,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<RemoteDevice | null> {
    const existing = this.deviceRow(deviceId)
    if (!existing) return null
    let revokedGeneration = existing.generation
    if (existing.state === "active") {
      revokedGeneration += 1
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `UPDATE devices SET state = 'revoked', generation = ?, updated_at = ?, revoked_at = ?
           WHERE device_id = ? AND state = 'active'`,
          revokedGeneration,
          nowSeconds,
          nowSeconds,
          deviceId
        )
        this.ctx.storage.sql.exec(
          `UPDATE device_presence SET state = 'offline', last_seen_at = ? WHERE device_id = ?`,
          nowSeconds,
          deviceId
        )
      })
      this.audit("device-revoked", deviceId, nowSeconds, {
        generation: revokedGeneration
      })
    }
    const registrySocketsClosed = this.closeDeviceSockets(
      deviceId,
      4003,
      "Device revoked"
    )
    const sessions = this.ctx.storage.sql
      .exec<SessionRow>(
        "SELECT session_id FROM device_sessions WHERE device_id = ?",
        deviceId
      )
      .toArray()
    let tunnelSocketsClosed = 0
    for (const session of sessions) {
      tunnelSocketsClosed += await this.env.SESSION_TUNNEL.getByName(
        session.session_id
      ).revokeDevice(deviceId, revokedGeneration, nowSeconds)
    }
    deviceRelayTelemetry("device_revocation", {
      deviceId,
      generation: revokedGeneration,
      reason: "revoked",
      registrySocketsClosed,
      sessionCount: sessions.length,
      tunnelSocketsClosed
    })
    return this.device(deviceId)
  }

  async renameDevice(
    deviceId: string,
    displayName: string,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<RemoteDevice | null> {
    const trimmed = displayName.trim()
    if (!trimmed || trimmed.length > 120) return null
    const existing = this.device(deviceId)
    if (!existing || existing.state !== "active") return null
    this.ctx.storage.sql.exec(
      "UPDATE devices SET display_name = ?, updated_at = ? WHERE device_id = ? AND state = 'active'",
      trimmed,
      nowSeconds,
      deviceId
    )
    this.audit("device-renamed", deviceId, nowSeconds, {
      displayName: trimmed
    })
    return this.device(deviceId)
  }

  async createChallenge(
    deviceId: string,
    purpose: "connect" | "rotate-key" = "connect",
    nowSeconds = Math.floor(Date.now() / 1_000),
    ttlSeconds = CHALLENGE_TTL_SECONDS
  ): Promise<DeviceChallenge | null> {
    const row = this.deviceRow(deviceId)
    const subject = this.subject()
    if (!row || row.state !== "active" || !subject) return null
    const challenge: DeviceChallenge = {
      version: 1,
      challengeId: randomOpaqueId("challenge"),
      subject,
      deviceId,
      nonce: base64Url(randomBytes(32)),
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + ttlSeconds
    }
    const nonceHash = await sha256(challenge.nonce)
    this.ctx.storage.sql.exec(
      `INSERT INTO device_challenges
       (challenge_id, device_id, nonce_hash, purpose, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      challenge.challengeId,
      deviceId,
      nonceHash,
      purpose,
      challenge.issuedAt,
      challenge.expiresAt
    )
    await this.scheduleAlarm()
    return challenge
  }

  async completeChallenge(
    challenge: DeviceChallenge,
    signature: string,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<DeviceChallengeResult> {
    return this.verifyChallenge(challenge, signature, "connect", nowSeconds)
  }

  async rotateKey(
    challenge: DeviceChallenge,
    newPublicKey: DevicePublicKey,
    signature: string,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<DeviceChallengeResult> {
    const verified = await this.verifyChallenge(
      challenge,
      signature,
      "rotate-key",
      nowSeconds,
      newPublicKey
    )
    if (verified.status !== "verified") return verified
    const nextGeneration = verified.generation + 1
    let rotated = false
    this.ctx.storage.transactionSync(() => {
      const update = this.ctx.storage.sql.exec(
        `UPDATE devices SET public_key_json = ?, generation = ?, updated_at = ?
         WHERE device_id = ? AND state = 'active' AND generation = ?`,
        JSON.stringify(newPublicKey),
        nextGeneration,
        nowSeconds,
        verified.deviceId,
        verified.generation
      )
      if (update.rowsWritten !== 1) return
      this.ctx.storage.sql.exec(
        `UPDATE device_presence SET state = 'offline', last_seen_at = ? WHERE device_id = ?`,
        nowSeconds,
        verified.deviceId
      )
      rotated = true
    })
    if (!rotated) return { status: "revoked" }
    this.audit("device-key-rotated", verified.deviceId, nowSeconds, {
      generation: nextGeneration
    })
    const registrySocketsClosed = this.closeDeviceSockets(
      verified.deviceId,
      4003,
      "Device key rotated"
    )
    const sessions = this.ctx.storage.sql
      .exec<SessionRow>(
        "SELECT session_id FROM device_sessions WHERE device_id = ?",
        verified.deviceId
      )
      .toArray()
    let tunnelSocketsClosed = 0
    for (const session of sessions) {
      tunnelSocketsClosed += await this.env.SESSION_TUNNEL.getByName(
        session.session_id
      ).revokeDevice(verified.deviceId, nextGeneration, nowSeconds)
    }
    deviceRelayTelemetry("device_revocation", {
      deviceId: verified.deviceId,
      generation: nextGeneration,
      reason: "key-rotation",
      registrySocketsClosed,
      sessionCount: sessions.length,
      tunnelSocketsClosed
    })
    return { ...verified, generation: nextGeneration }
  }

  async setPresence(
    deviceId: string,
    generation: number,
    state: "online" | "offline",
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<boolean> {
    const current = await this.assertGeneration(deviceId, generation)
    if (!current.active) return false
    this.ctx.storage.sql.exec(
      `UPDATE device_presence SET state = ?,
         connected_at = CASE WHEN ? = 'online' AND state = 'offline' THEN ? ELSE connected_at END,
         last_seen_at = ? WHERE device_id = ?`,
      state,
      state,
      nowSeconds,
      nowSeconds,
      deviceId
    )
    return true
  }

  async auditCount(): Promise<number> {
    return this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM audit_records")
      .one().count
  }

  override async alarm(): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1_000)
    this.ctx.storage.sql.exec(
      "DELETE FROM pending_devices WHERE expires_at <= ? AND claimed_subject IS NULL",
      nowSeconds
    )
    this.ctx.storage.sql.exec(
      "DELETE FROM device_challenges WHERE expires_at <= ?",
      nowSeconds
    )
    const expiredDevices = new Set<string>()
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(socket)
      if (!attachment || attachment.expiresAt <= nowSeconds) {
        if (attachment) expiredDevices.add(attachment.deviceId)
        safeSocketClose(socket, 4001, "Device grant expired")
      }
    }
    for (const deviceId of expiredDevices) {
      const live = this.ctx
        .getWebSockets(`device:${deviceId}`)
        .map((socket) => this.socketAttachment(socket))
        .some(
          (attachment) =>
            attachment !== null && attachment.expiresAt > nowSeconds
        )
      if (!live) {
        const device = this.deviceRow(deviceId)
        if (device)
          await this.setPresence(
            deviceId,
            device.generation,
            "offline",
            nowSeconds
          )
      }
    }
    await this.scheduleAlarm()
  }

  private subject(): string | null {
    return (
      this.ctx.storage.sql
        .exec<MetadataRow>(
          "SELECT value FROM registry_metadata WHERE key = 'subject'"
        )
        .toArray()[0]?.value ?? null
    )
  }

  private pending(pendingDeviceId: string): PendingDeviceRow | null {
    return (
      this.ctx.storage.sql
        .exec<PendingDeviceRow>(
          "SELECT * FROM pending_devices WHERE pending_device_id = ?",
          pendingDeviceId
        )
        .toArray()[0] ?? null
    )
  }

  private claimed(row: PendingDeviceRow): ClaimedPendingDevice {
    if (!row.claimed_subject) throw new Error("Pending device is not claimed")
    return {
      pendingDeviceId: row.pending_device_id,
      deviceId: row.device_id,
      claimedSubject: row.claimed_subject,
      displayName: row.display_name,
      platform: decodeJson(RemoteDevicePlatformSchema, row.platform_json),
      publicKey: decodeJson(DevicePublicKeySchema, row.public_key_json),
      ...(row.encryption_public_key_json
        ? { encryptionPublicKey: decodeJson(DeviceEncryptionPublicKeySchema, row.encryption_public_key_json) }
        : {}),
      capabilities: decodeJson(
        RemoteDeviceCapabilitiesSchema,
        row.capabilities_json
      ),
      createdAt: row.created_at
    }
  }

  private deviceRow(deviceId: string): DeviceRow | null {
    return (
      this.ctx.storage.sql
        .exec<DeviceRow>("SELECT * FROM devices WHERE device_id = ?", deviceId)
        .toArray()[0] ?? null
    )
  }

  private device(deviceId: string): RemoteDevice | null {
    const row = this.deviceRow(deviceId)
    return row ? this.deviceFromRow(row) : null
  }

  private deviceFromRow(row: DeviceRow): RemoteDevice {
    const presence =
      this.ctx.storage.sql
        .exec<PresenceRow>(
          "SELECT * FROM device_presence WHERE device_id = ?",
          row.device_id
        )
        .toArray()[0] ?? null
    const sessions = this.ctx.storage.sql
      .exec<SessionRow>(
        "SELECT session_id FROM device_sessions WHERE device_id = ? ORDER BY session_id ASC",
        row.device_id
      )
      .toArray()
    return {
      version: 1,
      deviceId: row.device_id,
      displayName: row.display_name,
      platform: decodeJson(RemoteDevicePlatformSchema, row.platform_json),
      publicKey: decodeJson(DevicePublicKeySchema, row.public_key_json),
      ...(row.encryption_public_key_json
        ? { encryptionPublicKey: decodeJson(DeviceEncryptionPublicKeySchema, row.encryption_public_key_json) }
        : {}),
      capabilities: decodeJson(
        RemoteDeviceCapabilitiesSchema,
        row.capabilities_json
      ),
      state: row.state,
      generation: row.generation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      presence: {
        version: 1,
        state: presence?.state ?? "offline",
        connectedAt: presence?.connected_at ?? null,
        lastSeenAt: presence?.last_seen_at ?? null,
        activeSessionIds: sessions.map((session) => session.session_id)
      }
    }
  }

  private async verifyChallenge(
    challenge: DeviceChallenge,
    signature: string,
    purpose: "connect" | "rotate-key",
    nowSeconds: number,
    newPublicKey?: DevicePublicKey
  ): Promise<DeviceChallengeResult> {
    const row = this.ctx.storage.sql
      .exec<ChallengeRow>(
        "SELECT * FROM device_challenges WHERE challenge_id = ?",
        challenge.challengeId
      )
      .toArray()[0]
    if (!row) return { status: "not-found" }
    const device = this.deviceRow(row.device_id)
    if (!device || device.state !== "active") return { status: "revoked" }
    if (row.consumed_at !== null) return { status: "replayed" }
    if (row.expires_at <= nowSeconds) return { status: "expired" }
    const subject = this.subject()
    const nonceHash = await sha256(challenge.nonce)
    if (
      !subject ||
      challenge.subject !== subject ||
      challenge.deviceId !== row.device_id ||
      challenge.issuedAt !== row.issued_at ||
      challenge.expiresAt !== row.expires_at ||
      row.purpose !== purpose ||
      !constantTimeEqual(row.nonce_hash, nonceHash)
    ) {
      return { status: "invalid-challenge" }
    }
    let verified = false
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        fromBase64Url(
          decodeJson(DevicePublicKeySchema, device.public_key_json).value
        ),
        { name: "Ed25519" },
        false,
        ["verify"]
      )
      verified = await crypto.subtle.verify(
        "Ed25519",
        key,
        fromBase64Url(signature),
        deviceChallengePayload(challenge, newPublicKey)
      )
    } catch {
      verified = false
    }
    if (!verified) return { status: "invalid-signature" }
    const consumed = this.ctx.storage.sql.exec(
      `UPDATE device_challenges SET consumed_at = ?
       WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?`,
      nowSeconds,
      row.challenge_id,
      nowSeconds
    )
    if (consumed.rowsWritten !== 1) return { status: "replayed" }
    this.audit("device-challenge-verified", device.device_id, nowSeconds, {
      purpose
    })
    await this.scheduleAlarm()
    return {
      status: "verified",
      subject,
      deviceId: device.device_id,
      generation: device.generation
    }
  }

  private audit(
    event: string,
    deviceId: string | null,
    occurredAt: number,
    details: Readonly<Record<string, unknown>>
  ): void {
    const serialized = JSON.stringify(details)
    const bounded =
      serialized.length <= 1_024
        ? serialized
        : JSON.stringify({ truncated: serialized.slice(0, 960) })
    this.ctx.storage.sql.exec(
      `INSERT INTO audit_records (event, device_id, occurred_at, details_json)
       VALUES (?, ?, ?, ?)`,
      event,
      deviceId,
      occurredAt,
      bounded
    )
    this.ctx.storage.sql.exec(
      `DELETE FROM audit_records WHERE id NOT IN
       (SELECT id FROM audit_records ORDER BY id DESC LIMIT ?)`,
      MAX_AUDIT_RECORDS
    )
  }

  private pairingTelemetry(
    outcome: string,
    deviceId: string | null,
    failedAttempts: number
  ): void {
    deviceRelayTelemetry(
      "pairing_attempt",
      { deviceId, failedAttempts, outcome },
      outcome === "claimed" ? "info" : "warn"
    )
  }

  private closeDeviceSockets(
    deviceId: string,
    code: number,
    reason: string
  ): number {
    let closed = 0
    for (const socket of this.ctx.getWebSockets()) {
      if (this.socketAttachment(socket)?.deviceId === deviceId) {
        safeSocketClose(socket, code, reason)
        closed += 1
      }
    }
    return closed
  }

  private socketAttachment(socket: WebSocket): DeviceSocketAttachment | null {
    const value: unknown = socket.deserializeAttachment()
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const candidate = Object.fromEntries(Object.entries(value))
    return typeof candidate.deviceId === "string" &&
      typeof candidate.generation === "number" &&
      typeof candidate.expiresAt === "number"
      ? {
          deviceId: candidate.deviceId,
          generation: candidate.generation,
          expiresAt: candidate.expiresAt
        }
      : null
  }

  private async scheduleAlarm(): Promise<void> {
    const pendingExpiry = this.ctx.storage.sql
      .exec<{
        readonly [key: string]: SqlStorageValue
        readonly expires_at: number | null
      }>(
        `SELECT MIN(expires_at) AS expires_at FROM pending_devices
         WHERE claimed_subject IS NULL AND expires_at > ?`,
        Math.floor(Date.now() / 1_000)
      )
      .one().expires_at
    const challengeExpiry = this.ctx.storage.sql
      .exec<{
        readonly [key: string]: SqlStorageValue
        readonly expires_at: number | null
      }>(
        `SELECT MIN(expires_at) AS expires_at FROM device_challenges
         WHERE consumed_at IS NULL AND expires_at > ?`,
        Math.floor(Date.now() / 1_000)
      )
      .one().expires_at
    const socketExpiries = this.ctx
      .getWebSockets()
      .map((socket) => this.socketAttachment(socket)?.expiresAt)
      .filter((expiresAt): expiresAt is number => typeof expiresAt === "number")
    const expiries = [pendingExpiry, challengeExpiry, ...socketExpiries].filter(
      (expiresAt): expiresAt is number => typeof expiresAt === "number"
    )
    if (expiries.length === 0) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    await this.ctx.storage.setAlarm(Math.min(...expiries) * 1_000)
  }
}
