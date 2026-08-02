import {
  MemoryRevisionNumber,
  MemorySource as MemorySourceSchema,
  canonicalJson,
  stableContentHash,
  type MemorySource
} from "@jingler/memory"
import { Schema } from "effect"
import type { R2BucketLike, R2ObjectLike, R2PutOptionsLike } from "./env.js"

export interface StoredSourceRecord {
  readonly source: MemorySource
  readonly contentHash: string
  readonly contentKey: string
}

export interface StoredRevisionRecord {
  readonly id: string
  readonly pageId: string
  readonly revision: number
  readonly parentRevisionId?: string
  readonly contentHash: string
  readonly markdownKey: string
  readonly authorId: string
  readonly createdAt: string
  readonly acceptedAt: string
  /** Present for revisions which become visible only as one committed publication set. */
  readonly publicationId?: string
}

export interface StoredPublicationRecord {
  readonly id: string
  readonly revisionIds: ReadonlyArray<string>
  readonly acceptedAt: string
}

export class MemoryObjectStoreError extends Error {
  override readonly name = "MemoryObjectStoreError"
}

const StoredId = Schema.String.pipe(Schema.minLength(1))
const StoredSourceRecordSchema = Schema.Struct({
  source: MemorySourceSchema,
  contentHash: StoredId,
  contentKey: StoredId
})
const StoredRevisionRecordSchema = Schema.Struct({
  id: StoredId,
  pageId: StoredId,
  revision: MemoryRevisionNumber,
  parentRevisionId: Schema.optional(Schema.String),
  contentHash: StoredId,
  markdownKey: StoredId,
  authorId: StoredId,
  createdAt: StoredId,
  acceptedAt: StoredId,
  publicationId: Schema.optional(Schema.String)
})
const StoredPublicationRecordSchema = Schema.Struct({
  id: StoredId,
  revisionIds: Schema.Array(StoredId).pipe(Schema.minItems(1)),
  acceptedAt: StoredId
})

const encodeSegment = (value: string): string => encodeURIComponent(value)

export const organizationPrefix = (organizationId: string): string =>
  `organizations/${encodeSegment(organizationId)}/`

/** The single mutable pointer holding the newest vault history (see {@link MemoryR2Store.putHistory}). */
const HISTORY_LATEST_KEY = "history/latest.json"

/** How often (in versions) a durable immutable history checkpoint is also written. */
export const HISTORY_SNAPSHOT_INTERVAL = 16

const ORGANIZATIONS_ROOT = "organizations/"

/**
 * Every organization that currently has a vault in R2, discovered by listing the
 * `organizations/<id>/` common prefixes. The daily drift sweep uses this so EVERY
 * org with a vault is reconciled — not only those opted into lint — closing the
 * gap where a single failed publication trigger would leave a namespace stale
 * forever. Bounded to one delimited-prefix entry per org, not one per object.
 */
export const listOrganizationIds = async (bucket: R2BucketLike): Promise<Array<string>> => {
  const ids = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await bucket.list({
      prefix: ORGANIZATIONS_ROOT,
      delimiter: "/",
      ...(cursor === undefined ? {} : { cursor })
    })
    for (const prefix of page.delimitedPrefixes ?? []) {
      const encoded = prefix.slice(ORGANIZATIONS_ROOT.length).replace(/\/$/, "")
      if (encoded.length === 0) continue
      try {
        ids.add(decodeURIComponent(encoded))
      } catch {
        // A malformed prefix cannot masquerade as another org; skip it.
      }
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
  return [...ids].sort()
}

export const sha256ContentHash = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const readRequired = async (bucket: R2BucketLike, key: string): Promise<string> => {
  const object = await bucket.get(key)
  if (object === null) throw new MemoryObjectStoreError(`missing immutable object ${key}`)
  return object.text()
}

const putImmutable = async (
  bucket: R2BucketLike,
  key: string,
  value: string,
  contentType: string
): Promise<void> => {
  const existing = await bucket.get(key)
  if (existing !== null) {
    if ((await existing.text()) !== value) {
      throw new MemoryObjectStoreError(`immutable object collision at ${key}`)
    }
    return
  }
  const stored = await bucket.put(key, value, {
    httpMetadata: { contentType },
    onlyIf: { etagDoesNotMatch: "*" }
  })
  if (stored === null) {
    const raced = await bucket.get(key)
    if (raced === null || (await raced.text()) !== value) {
      throw new MemoryObjectStoreError(`failed to persist immutable object ${key}`)
    }
  }
}

const listAllKeys = async (bucket: R2BucketLike, prefix: string): Promise<Array<string>> => {
  const keys: Array<string> = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) })
    keys.push(...page.objects.map((object) => object.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
  return keys.sort()
}

export class MemoryR2Store {
  constructor(
    readonly organizationId: string,
    private readonly bucket: R2BucketLike
  ) {}

  private key(suffix: string): string {
    return `${organizationPrefix(this.organizationId)}${suffix}`
  }

  async putSource(source: MemorySource, content: string): Promise<StoredSourceRecord> {
    const contentHash = await sha256ContentHash(content)
    const contentKey = this.key(`sources/blobs/${contentHash}`)
    await putImmutable(this.bucket, contentKey, content, "application/octet-stream")
    const record: StoredSourceRecord = {
      source: { ...source, contentHash },
      contentHash,
      contentKey
    }
    const recordJson = canonicalJson(record)
    const recordHash = await sha256ContentHash(recordJson)
    await putImmutable(
      this.bucket,
      this.key(`sources/records/${recordHash}.json`),
      recordJson,
      "application/json"
    )
    return record
  }

  async putAcceptedRevision(
    markdown: string,
    record: Omit<StoredRevisionRecord, "contentHash" | "markdownKey">
  ): Promise<StoredRevisionRecord> {
    const contentHash = await sha256ContentHash(markdown)
    const markdownKey = this.key(`pages/blobs/${contentHash}.md`)
    await putImmutable(this.bucket, markdownKey, markdown, "text/markdown; charset=utf-8")
    const stored: StoredRevisionRecord = { ...record, contentHash, markdownKey }
    const recordJson = canonicalJson(stored)
    const recordHash = await sha256ContentHash(recordJson)
    await putImmutable(
      this.bucket,
      this.key(`revisions/${recordHash}.json`),
      recordJson,
      "application/json"
    )
    return stored
  }

  async putPublicationCommit(record: StoredPublicationRecord): Promise<StoredPublicationRecord> {
    const normalized: StoredPublicationRecord = {
      ...record,
      revisionIds: [...new Set(record.revisionIds)].sort()
    }
    await putImmutable(
      this.bucket,
      this.key(`publications/${encodeSegment(record.id)}.json`),
      canonicalJson(normalized),
      "application/json"
    )
    return normalized
  }

  /**
   * Persist the vault history for `version`. Writes are O(1), not O(N):
   *
   * 1. Always overwrite the single MUTABLE `history/latest.json` pointer — this is
   *    what {@link readLatestHistorySnapshot} reads with one bounded GET, so the read
   *    never lists every key.
   * 2. Only every {@link HISTORY_SNAPSHOT_INTERVAL} versions also write an IMMUTABLE
   *    checkpoint, so durable history is retained without minting a fresh immutable
   *    object (and a longer list to scan) on every single mutation — the previous
   *    behaviour, which grew unbounded and made the latest-read O(N).
   *
   * Rebuild correctness is preserved: the mutable latest pointer always holds the
   * newest history, and the immutable checkpoints are a durable superset.
   */
  async putHistory(version: number, value: string): Promise<void> {
    await this.bucket.put(this.key(HISTORY_LATEST_KEY), value, {
      httpMetadata: { contentType: "application/json" }
    })
    if (version % HISTORY_SNAPSHOT_INTERVAL === 0) {
      await this.putHistorySnapshot(version, value)
    }
  }

  async putHistorySnapshot(version: number, value: string): Promise<void> {
    const versionKey = String(version).padStart(16, "0")
    const hash = await sha256ContentHash(value)
    await putImmutable(
      this.bucket,
      this.key(`history/snapshots/${versionKey}-${hash}.json`),
      value,
      "application/json"
    )
  }

  async readLatestHistorySnapshot(): Promise<string | null> {
    // Bounded: one GET of the mutable latest pointer. Only vaults written before the
    // pointer existed fall back to listing the immutable checkpoints.
    const latest = await this.bucket.get(this.key(HISTORY_LATEST_KEY))
    if (latest !== null) return latest.text()
    const keys = await listAllKeys(this.bucket, this.key("history/snapshots/"))
    const newest = keys.at(-1)
    return newest === undefined ? null : readRequired(this.bucket, newest)
  }

  private retrievalDayKey(day: string): string {
    return this.key(`history/retrievals/${encodeSegment(day)}.json`)
  }

  /** The current rollup array (JSON) for one UTC day, or null if none exists yet. */
  async readRetrievalDay(day: string): Promise<string | null> {
    const object = await this.bucket.get(this.retrievalDayKey(day))
    return object === null ? null : object.text()
  }

  /**
   * Overwrite one UTC day's retrieval rollup. This is a MUTABLE put (not
   * {@link putImmutable}) precisely because it is read-modify-written on the search
   * path: retrieval metrics are ephemeral, privacy-safe analytics — never a
   * source of truth — so R2 growth is bounded to one capped object per UTC day
   * rather than one immutable object per search.
   */
  async putRetrievalDay(day: string, value: string): Promise<void> {
    await this.bucket.put(this.retrievalDayKey(day), value, {
      httpMetadata: { contentType: "application/json" }
    })
  }

  /**
   * The newest `newestDays` day-rollups (each a JSON array), oldest-first. Day keys
   * are `YYYY-MM-DD`, so lexical order is chronological and the newest slice bounds
   * recovery time regardless of how long the vault has existed.
   */
  async listRetrievalDays(newestDays: number): Promise<Array<string>> {
    const keys = await listAllKeys(this.bucket, this.key("history/retrievals/"))
    const newest = newestDays <= 0 ? [] : keys.slice(-newestDays)
    return Promise.all(newest.map((key) => readRequired(this.bucket, key)))
  }

  readMarkdown(key: string): Promise<string> {
    if (!key.startsWith(organizationPrefix(this.organizationId))) {
      return Promise.reject(new MemoryObjectStoreError("cross-organization object key rejected"))
    }
    return readRequired(this.bucket, key)
  }

  readSourceContent(record: StoredSourceRecord): Promise<string> {
    return this.readMarkdown(record.contentKey)
  }

  async listRevisionRecords(): Promise<Array<StoredRevisionRecord>> {
    const keys = await listAllKeys(this.bucket, this.key("revisions/"))
    return Promise.all(
      keys.map(async (key) => parseStoredRevisionRecord(await readRequired(this.bucket, key)))
    )
  }

  async listSourceRecords(): Promise<Array<StoredSourceRecord>> {
    const keys = await listAllKeys(this.bucket, this.key("sources/records/"))
    return Promise.all(
      keys.map(async (key) => parseStoredSourceRecord(await readRequired(this.bucket, key)))
    )
  }

  async listPublicationRecords(): Promise<Array<StoredPublicationRecord>> {
    const keys = await listAllKeys(this.bucket, this.key("publications/"))
    return Promise.all(
      keys.map(async (key) => parseStoredPublicationRecord(await readRequired(this.bucket, key)))
    )
  }
}

const parseStoredRecord = <A, I>(
  value: string,
  schema: Schema.Schema<A, I>,
  label: string
): A => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new MemoryObjectStoreError(`invalid stored JSON: ${String(error)}`)
  }
  try {
    return Schema.decodeUnknownSync(schema)(parsed)
  } catch {
    throw new MemoryObjectStoreError(`invalid stored ${label}`)
  }
}

export const parseStoredRevisionRecord = (value: string): StoredRevisionRecord =>
  parseStoredRecord(value, StoredRevisionRecordSchema, "revision record")

export const parseStoredPublicationRecord = (value: string): StoredPublicationRecord => {
  const record = parseStoredRecord(value, StoredPublicationRecordSchema, "publication record")
  return {
    id: record.id,
    revisionIds: [...new Set(record.revisionIds)].sort(),
    acceptedAt: record.acceptedAt
  }
}

export const parseStoredSourceRecord = (value: string): StoredSourceRecord =>
  parseStoredRecord(value, StoredSourceRecordSchema, "source record")

class MemoryR2Object implements R2ObjectLike {
  readonly etag: string

  constructor(
    readonly key: string,
    private readonly value: string
  ) {
    this.etag = stableContentHash(value)
  }

  async text(): Promise<string> {
    return this.value
  }
}

/** Deterministic R2 substitute used by unit tests and local consumers. */
export class InMemoryR2Bucket implements R2BucketLike {
  private readonly values = new Map<string, string>()

  async head(key: string): Promise<{ readonly key: string; readonly etag?: string } | null> {
    const value = this.values.get(key)
    return value === undefined ? null : { key, etag: stableContentHash(value) }
  }

  async get(key: string): Promise<R2ObjectLike | null> {
    const value = this.values.get(key)
    return value === undefined ? null : new MemoryR2Object(key, value)
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: R2PutOptionsLike
  ): Promise<{ readonly key: string } | null> {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.values.has(key)) return null
    const text =
      typeof value === "string"
        ? value
        : new TextDecoder().decode(
            value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          )
    this.values.set(key, text)
    return { key }
  }

  async list(options?: {
    readonly prefix?: string
    readonly cursor?: string
    readonly delimiter?: string
  }): Promise<{
    readonly objects: ReadonlyArray<{ readonly key: string }>
    readonly truncated: boolean
    readonly delimitedPrefixes?: ReadonlyArray<string>
  }> {
    const prefix = options?.prefix ?? ""
    const matching = [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort()
    const delimiter = options?.delimiter
    if (delimiter === undefined) {
      return { objects: matching.map((key) => ({ key })), truncated: false }
    }
    // Roll matching keys up to the first delimiter past the prefix, exactly as R2
    // does: keys with a delimiter become common prefixes, the rest stay objects.
    const objects: Array<{ readonly key: string }> = []
    const delimitedPrefixes = new Set<string>()
    for (const key of matching) {
      const rest = key.slice(prefix.length)
      const index = rest.indexOf(delimiter)
      if (index === -1) objects.push({ key })
      else delimitedPrefixes.add(`${prefix}${rest.slice(0, index + delimiter.length)}`)
    }
    return { objects, truncated: false, delimitedPrefixes: [...delimitedPrefixes].sort() }
  }

  keys(): ReadonlyArray<string> {
    return [...this.values.keys()].sort()
  }

  /** Simulate backup corruption in recovery tests. */
  deleteForTest(key: string): void {
    this.values.delete(key)
  }
}
