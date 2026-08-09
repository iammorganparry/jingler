import {
  RELAY_USAGE_POLICY,
  type RelayAdmission,
  type RelayUsageState
} from "@jingler/core"
import { DurableObject } from "cloudflare:workers"

export {
  RELAY_USAGE_POLICY,
  admitRelayAttachment,
  allowRelayControlOperation,
  emptyRelayUsage,
  recordRelayCiphertext,
  releaseRelayAttachment
} from "@jingler/core"
export type { RelayAdmission, RelayUsageState } from "@jingler/core"

export interface RelayAttachmentAdmission {
  readonly attachmentId: string
  readonly deviceId: string
  readonly clientInstanceId: string
  readonly sourceIp: string
  readonly expiresAt?: number
}

export interface RelayUsageSnapshot extends RelayUsageState {
  readonly quotaBytes: number
  readonly deviceId?: string
  readonly deviceCiphertextBytesIn?: number
  readonly deviceCiphertextBytesOut?: number
}

export type RelayTransferReservation =
  | { readonly status: "reserved"; readonly bytes: number }
  | { readonly status: "quota-exceeded" | "invalid-frame" }

interface UsageRow {
  readonly [key: string]: SqlStorageValue
  readonly ciphertext_bytes_in: number
  readonly ciphertext_bytes_out: number
}

interface CountRow {
  readonly [key: string]: SqlStorageValue
  readonly count: number
}

interface AttachmentRow {
  readonly [key: string]: SqlStorageValue
  readonly attachment_id: string
  readonly device_id: string
}

interface DeviceUsageRow {
  readonly [key: string]: SqlStorageValue
  readonly ciphertext_bytes_in: number
  readonly ciphertext_bytes_out: number
}

/** One strongly-consistent usage ledger per account subject. */
export class RelayUsageObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS account_usage (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          ciphertext_bytes_in INTEGER NOT NULL DEFAULT 0,
          ciphertext_bytes_out INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO account_usage (singleton) VALUES (1);
        CREATE TABLE IF NOT EXISTS device_usage (
          device_id TEXT PRIMARY KEY,
          ciphertext_bytes_in INTEGER NOT NULL DEFAULT 0,
          ciphertext_bytes_out INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS active_attachments (
          attachment_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          client_instance_id TEXT NOT NULL,
          source_ip TEXT NOT NULL,
          attached_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS active_attachments_device
          ON active_attachments(device_id);
        CREATE TABLE IF NOT EXISTS released_attachments (
          attachment_id TEXT PRIMARY KEY,
          released_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS released_attachments_age
          ON released_attachments(released_at);
        CREATE TABLE IF NOT EXISTS attempt_windows (
          dimension TEXT NOT NULL CHECK (dimension IN ('account', 'client', 'ip')),
          value TEXT NOT NULL,
          window_started_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL,
          PRIMARY KEY (dimension, value)
        );
        INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
      `)
      this.ctx.storage.transactionSync(() => {
        const attachmentExpiryMigration = this.ctx.storage.sql
          .exec<{ readonly id: number }>(
            "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (3) RETURNING id"
          )
          .toArray()[0]
        if (attachmentExpiryMigration) {
          const activeAttachmentColumns = new Set(
            [...this.ctx.storage.sql.exec<{ readonly name: string }>(
              "PRAGMA table_info(active_attachments)"
            )].map((column) => column.name)
          )
          if (!activeAttachmentColumns.has("expires_at")) {
            this.ctx.storage.sql.exec(
              "ALTER TABLE active_attachments ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0"
            )
          }
        }
      })
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS active_attachments_expiry
          ON active_attachments(expires_at);
        CREATE INDEX IF NOT EXISTS attempt_windows_started_at
          ON attempt_windows(window_started_at);
        INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (2);
      `)
    })
  }

  async admit(
    input: RelayAttachmentAdmission,
    quotaBytes = RELAY_USAGE_POLICY.defaultAccountQuotaBytes,
    nowSeconds = Math.floor(Date.now() / 1_000)
  ): Promise<RelayAdmission["status"]> {
    const expiresAt = input.expiresAt ?? nowSeconds + 15 * 60
    const keys = [
      ["account", "account"],
      ["client", input.clientInstanceId],
      ["ip", input.sourceIp]
    ] as const
    let rateLimited = false
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM active_attachments WHERE expires_at <= ?",
        nowSeconds
      )
      this.ctx.storage.sql.exec(
        "DELETE FROM released_attachments WHERE released_at <= ?",
        nowSeconds - 24 * 60 * 60
      )
      this.ctx.storage.sql.exec(
        "DELETE FROM attempt_windows WHERE window_started_at <= ?",
        nowSeconds - 60
      )
      const attempts = this.ctx.storage.sql.exec<{
          readonly [key: string]: SqlStorageValue
          readonly attempts: number
        }>(
          `INSERT INTO attempt_windows (dimension, value, window_started_at, attempts)
           VALUES (?, ?, ?, 1), (?, ?, ?, 1), (?, ?, ?, 1)
           ON CONFLICT(dimension, value) DO UPDATE SET
             window_started_at = CASE
               WHEN excluded.window_started_at - attempt_windows.window_started_at >= 60
               THEN excluded.window_started_at
               ELSE attempt_windows.window_started_at
             END,
             attempts = CASE
               WHEN excluded.window_started_at - attempt_windows.window_started_at >= 60
               THEN 1
               ELSE attempt_windows.attempts + 1
             END
           RETURNING attempts`,
          keys[0][0],
          keys[0][1],
          nowSeconds,
          keys[1][0],
          keys[1][1],
          nowSeconds,
          keys[2][0],
          keys[2][1],
          nowSeconds
        ).toArray()
      rateLimited = attempts.some(
        (result) => result.attempts > RELAY_USAGE_POLICY.maximumAttachmentAttemptsPerMinute
      )
    })
    if (rateLimited) return "rate-limited"
    const admitted = this.ctx.storage.sql.exec<AttachmentRow>(
      `INSERT INTO active_attachments
       (attachment_id, device_id, client_instance_id, source_ip, attached_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (
         SELECT ciphertext_bytes_in + ciphertext_bytes_out
         FROM account_usage WHERE singleton = 1
       ) < ?
       AND (
         SELECT COUNT(*) FROM active_attachments WHERE device_id = ?
       ) < ?
       ON CONFLICT(attachment_id) DO NOTHING
       RETURNING attachment_id, device_id`,
      input.attachmentId,
      input.deviceId,
      input.clientInstanceId,
      input.sourceIp,
      nowSeconds,
      expiresAt,
      quotaBytes,
      input.deviceId,
      RELAY_USAGE_POLICY.maximumConcurrentClientsPerDevice
    ).toArray()[0]
    if (admitted) return "admitted"

    // Rejections are uncommon, so preserve precise error reporting without
    // charging every successful attachment for separate quota/count reads.
    const existing = this.ctx.storage.sql.exec<AttachmentRow>(
      "SELECT attachment_id, device_id FROM active_attachments WHERE attachment_id = ?",
      input.attachmentId
    ).toArray()[0]
    if (existing?.device_id === input.deviceId) return "admitted"
    const usage = this.usage()
    if (usage.ciphertext_bytes_in + usage.ciphertext_bytes_out >= quotaBytes) {
      return "quota-exceeded"
    }
    return "concurrency-exceeded"
  }

  async recordTransfer(
    deviceId: string,
    bytes: number,
    quotaBytes = RELAY_USAGE_POLICY.defaultAccountQuotaBytes
  ): Promise<"recorded" | "quota-exceeded" | "invalid-frame"> {
    const result = await this.reserveTransfer(deviceId, bytes, quotaBytes, bytes)
    return result.status === "reserved" ? "recorded" : result.status
  }

  /**
   * Reserves a transfer chunk in the account ledger. Session objects consume
   * that budget from their hibernation attachment and only return here when a
   * chunk is exhausted, avoiding a cross-object RPC and two writes per frame.
   */
  async reserveTransfer(
    deviceId: string,
    minimumBytes: number,
    quotaBytes = RELAY_USAGE_POLICY.defaultAccountQuotaBytes,
    preferredBytes = RELAY_USAGE_POLICY.transferReservationBytes
  ): Promise<RelayTransferReservation> {
    if (
      !Number.isSafeInteger(minimumBytes) ||
      minimumBytes < 0 ||
      minimumBytes > RELAY_USAGE_POLICY.maximumFrameBytes ||
      !Number.isSafeInteger(preferredBytes) ||
      preferredBytes < minimumBytes
    ) {
      return { status: "invalid-frame" }
    }
    const reserveExact = (bytes: number): boolean =>
      this.ctx.storage.transactionSync(() => {
        const account = this.ctx.storage.sql.exec<UsageRow>(
          `UPDATE account_usage SET
           ciphertext_bytes_in = ciphertext_bytes_in + ?,
           ciphertext_bytes_out = ciphertext_bytes_out + ?
           WHERE singleton = 1
             AND ciphertext_bytes_in + ciphertext_bytes_out + ? <= ?
           RETURNING ciphertext_bytes_in, ciphertext_bytes_out`,
          bytes,
          bytes,
          bytes * 2,
          quotaBytes
        ).toArray()[0]
        if (!account) return false
        this.ctx.storage.sql.exec(
          `INSERT INTO device_usage (device_id, ciphertext_bytes_in, ciphertext_bytes_out)
           VALUES (?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             ciphertext_bytes_in = ciphertext_bytes_in + excluded.ciphertext_bytes_in,
             ciphertext_bytes_out = ciphertext_bytes_out + excluded.ciphertext_bytes_out`,
          deviceId,
          bytes,
          bytes
        )
        return true
      })
    const targetBytes = Math.max(minimumBytes, preferredBytes)
    if (reserveExact(targetBytes)) {
      return { status: "reserved", bytes: targetBytes }
    }
    if (targetBytes !== minimumBytes && reserveExact(minimumBytes)) {
      return { status: "reserved", bytes: minimumBytes }
    }
    return { status: "quota-exceeded" }
  }

  async release(
    attachmentId: string,
    deviceId?: string,
    unusedTransferBytes = 0
  ): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM active_attachments WHERE attachment_id = ?",
        attachmentId
      )
      // Expiry pruning may remove the active row before close delivery. Keep a
      // short-lived idempotency fence so that close/RPC retries refund exactly
      // once without retaining every historical attachment forever.
      const released = this.ctx.storage.sql.exec<{ readonly attachment_id: string }>(
        `INSERT INTO released_attachments (attachment_id, released_at)
         VALUES (?, ?)
         ON CONFLICT(attachment_id) DO NOTHING
         RETURNING attachment_id`,
        attachmentId,
        Math.floor(Date.now() / 1_000)
      ).toArray()[0]
      if (!released || !deviceId || unusedTransferBytes <= 0) return
      this.ctx.storage.sql.exec(
        `UPDATE account_usage SET
         ciphertext_bytes_in = MAX(0, ciphertext_bytes_in - ?),
         ciphertext_bytes_out = MAX(0, ciphertext_bytes_out - ?)
         WHERE singleton = 1`,
        unusedTransferBytes,
        unusedTransferBytes
      )
      this.ctx.storage.sql.exec(
        `UPDATE device_usage SET
         ciphertext_bytes_in = MAX(0, ciphertext_bytes_in - ?),
         ciphertext_bytes_out = MAX(0, ciphertext_bytes_out - ?)
         WHERE device_id = ?`,
        unusedTransferBytes,
        unusedTransferBytes,
        deviceId
      )
    })
  }

  async snapshot(
    quotaBytes = RELAY_USAGE_POLICY.defaultAccountQuotaBytes,
    deviceId?: string
  ): Promise<RelayUsageSnapshot> {
    const usage = this.usage()
    const deviceUsage = deviceId
      ? this.ctx.storage.sql.exec<DeviceUsageRow>(
          "SELECT ciphertext_bytes_in, ciphertext_bytes_out FROM device_usage WHERE device_id = ?",
          deviceId
        ).toArray()[0]
      : undefined
    return {
      ciphertextBytesIn: usage.ciphertext_bytes_in,
      ciphertextBytesOut: usage.ciphertext_bytes_out,
      activeAttachments: this.ctx.storage.sql.exec<CountRow>(
        "SELECT COUNT(*) AS count FROM active_attachments"
      ).one().count,
      attachmentAttempts: this.ctx.storage.sql.exec<CountRow>(
        "SELECT COALESCE(SUM(attempts), 0) AS count FROM attempt_windows WHERE window_started_at > ?",
        Math.floor(Date.now() / 1_000) - 60
      ).one().count,
      attemptWindowStartedAt: 0,
      quotaBytes,
      ...(deviceId
        ? {
            deviceId,
            deviceCiphertextBytesIn: deviceUsage?.ciphertext_bytes_in ?? 0,
            deviceCiphertextBytesOut: deviceUsage?.ciphertext_bytes_out ?? 0
          }
        : {})
    }
  }

  private usage(): UsageRow {
    return this.ctx.storage.sql.exec<UsageRow>(
      "SELECT ciphertext_bytes_in, ciphertext_bytes_out FROM account_usage WHERE singleton = 1"
    ).one()
  }
}
