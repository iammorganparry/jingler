import {
  MemoryRetrievalSummary,
  type MemoryRetrievalSummary as MemoryRetrievalSummaryType
} from "@jingler/core"
import {
  MemoryAuditEvent as MemoryAuditEventSchema,
  MemoryProposal as MemoryProposalSchema,
  MemorySource as MemorySourceSchema,
  assertMemoryValid,
  buildBacklinkIndex,
  buildMemoryGraph,
  canonicalJson,
  compareText,
  parseMemoryMarkdown,
  parseMemoryPage,
  serializeMemoryMarkdown,
  SUGGESTION_POLICY_DEFAULT,
  type MemoryAuditEvent,
  type MemoryPage,
  type MemoryProposal,
  type MemorySource,
  type SuggestedLink,
  type SuggestionPolicy
} from "@jingler/memory"
import { Effect, Schema } from "effect"
import {
  buildVaultDashboardSummary,
  type RetrievalMetric,
  type SessionRetrievalMetric,
  type VaultDashboardSummary
} from "./analytics.js"
import type { DurableObjectStorageLike, R2BucketLike, SqlStorageLike } from "./env.js"
import {
  buildBoundedGraphView,
  buildGraphNeighborhood,
  findGraphEdgeEvidence,
  type VaultGraphEvidenceResponse,
  type VaultGraphView
} from "./graph.js"
import {
  NEW_PAGE_BASE_REVISION_ID,
  prepareProposalSet,
  proposalSetMatches,
  type CreateProposalSetInput,
  type VaultProposalSet
} from "./proposals.js"
import {
  MemoryR2Store,
  sha256ContentHash,
  type StoredRevisionRecord,
  type StoredSourceRecord
} from "./r2-store.js"
import {
  buildSearchProjection,
  searchAcceptedPages,
  type SearchProjection,
  type VaultSearchResponse
} from "./search.js"
import { combineSuggestions } from "./suggestions.js"
import type { TurbopufferNeighbor, TurbopufferVectorLayer } from "./turbopuffer.js"

export interface VaultSuggestionsResponse {
  readonly version: 1
  readonly policy: SuggestionPolicy
  /** Where the embedding half of the suggestions came from, if anywhere. */
  readonly vectorSource: "turbopuffer" | "lexical"
  readonly suggestions: ReadonlyArray<SuggestedLink>
}

export interface VaultPageHead {
  readonly pageId: string
  readonly path: string
  readonly title: string
  readonly revisionId: string
  readonly revision: number
  readonly contentHash: string
  readonly markdownKey: string
  readonly acceptedAt: string
}

export interface VaultSnapshot {
  readonly version: number
  readonly heads: ReadonlyArray<VaultPageHead>
  readonly revisions: ReadonlyArray<StoredRevisionRecord>
  readonly sources: ReadonlyArray<StoredSourceRecord>
  readonly proposals: ReadonlyArray<MemoryProposal>
  readonly proposalSets: ReadonlyArray<VaultProposalSet>
  readonly events: ReadonlyArray<MemoryAuditEvent>
  readonly retrievals: ReadonlyArray<RetrievalMetric>
  readonly sessionRetrievals: ReadonlyArray<SessionRetrievalMetric>
}

export interface VaultStateStorage {
  initialize(): Effect.Effect<void, MemoryVaultError>
  load(): Effect.Effect<VaultSnapshot, MemoryVaultError>
  commit(
    expectedVersion: number,
    next: VaultSnapshot,
    projection: SearchProjection,
    pages: ReadonlyArray<MemoryPage>
  ): Effect.Effect<boolean, MemoryVaultError>
  loadProjectedPages(
    pageIds?: ReadonlyArray<string>
  ): Effect.Effect<ReadonlyArray<MemoryPage> | undefined, MemoryVaultError>
  loadNavigation(): Effect.Effect<
    Pick<SearchProjection, "indexMarkdown" | "logMarkdown"> | undefined,
    MemoryVaultError
  >
  searchPageIds(
    query: string,
    limit: number
  ): Effect.Effect<ReadonlyArray<string> | undefined, MemoryVaultError>
  recordRetrieval(metric: RetrievalMetric): Effect.Effect<void, MemoryVaultError>
  listRetrievals(): Effect.Effect<ReadonlyArray<RetrievalMetric>, MemoryVaultError>
}

export interface IngestAcceptedPageInput {
  readonly revisionId: string
  readonly markdown: string
  readonly actorId: string
  readonly createdAt: string
}

export interface CreateProposalInput {
  readonly id: string
  readonly pageId: string
  readonly baseRevisionId: string
  readonly markdown: string
  readonly proposedBy: string
  readonly createdAt: string
  readonly summary?: string
}

export type ApprovalResult =
  | {
      readonly status: "accepted"
      readonly proposalId: string
      readonly pageId: string
      readonly revisionId: string
      readonly revision: number
    }
  | {
      readonly status: "conflict"
      readonly proposalId: string
      readonly pageId: string
      readonly expectedBaseRevisionId: string
      readonly currentHeadRevisionId: string
    }

export type ProposalSetApprovalResult =
  | {
      readonly status: "accepted"
      readonly proposalSetId: string
      readonly revisions: ReadonlyArray<{
        readonly proposalId: string
        readonly pageId: string
        readonly revisionId: string
        readonly revision: number
      }>
    }
  | {
      readonly status: "conflict"
      readonly proposalSetId: string
      readonly conflicts: ReadonlyArray<{
        readonly pageId: string
        readonly expectedBaseRevisionId: string
        readonly currentHeadRevisionId: string
      }>
    }

export interface AcceptedPageResponse {
  readonly page: MemoryPage
  readonly revision: StoredRevisionRecord
  readonly sourceIds: ReadonlyArray<string>
  readonly citationIds: ReadonlyArray<string>
}

export interface ReadPageResponse extends AcceptedPageResponse {
  /** Bare accepted page ids linking to this page; complete, not graph-window capped. */
  readonly backlinks: ReadonlyArray<string>
}

export interface CompilerVaultContext {
  readonly candidates: ReadonlyArray<{
    readonly page: MemoryPage
    readonly revisionId: string
  }>
  readonly schemaPages: ReadonlyArray<MemoryPage>
  readonly indexMarkdown: string
}

export interface StoredSourceResponse {
  readonly source: MemorySource
  readonly contentHash: string
  readonly content: string
}

export interface RebuildResult {
  readonly pages: number
  readonly revisions: number
  readonly sources: number
}

export interface VaultExportFile {
  readonly path: string
  readonly content: string
}

export interface VaultExport {
  readonly format: "jingler-obsidian-vault"
  readonly version: 1
  readonly files: ReadonlyArray<VaultExportFile>
}

/**
 * The vault's typed failure. A `Schema.TaggedError` (not a bare `Error`) so it
 * composes as an Effect error channel and still crosses the DO fetch boundary as
 * a real `Error` instance — `errorResponse` matches it by `instanceof` and reads
 * `code`/`status`, exactly as before. `status` defaults to 400 when omitted.
 */
export class MemoryVaultError extends Schema.TaggedError<MemoryVaultError>()("MemoryVaultError", {
  code: Schema.Literal("not_found", "conflict", "invalid", "storage_conflict"),
  message: Schema.String,
  status: Schema.optionalWith(Schema.Literal(400, 404, 409), { default: () => 400 as const })
}) {}

const StoredRevisionRecordSchema = Schema.Struct({
  id: Schema.String,
  pageId: Schema.String,
  revision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  parentRevisionId: Schema.optional(Schema.String),
  contentHash: Schema.String,
  markdownKey: Schema.String,
  authorId: Schema.String,
  createdAt: Schema.String,
  acceptedAt: Schema.String,
  publicationId: Schema.optional(Schema.String)
})

const StoredSourceRecordSchema = Schema.Struct({
  source: MemorySourceSchema,
  contentHash: Schema.String,
  contentKey: Schema.String
})

const VaultPageHeadSchema = Schema.Struct({
  pageId: Schema.String,
  path: Schema.String,
  title: Schema.String,
  revisionId: Schema.String,
  revision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  contentHash: Schema.String,
  markdownKey: Schema.String,
  acceptedAt: Schema.String
})

const RetrievalMetricSchema = Schema.Struct({
  id: Schema.String,
  occurredAt: Schema.String,
  queryHash: Schema.String,
  resultCount: Schema.Int.pipe(Schema.nonNegative()),
  durationMs: Schema.Number.pipe(Schema.nonNegative())
})

const SessionRetrievalMetricSchema = Schema.Struct({
  id: Schema.String,
  occurredAt: Schema.String,
  ...MemoryRetrievalSummary.fields
})

const VaultProposalSetSchema = Schema.Struct({
  id: Schema.String,
  workflowId: Schema.String,
  sourceId: Schema.String,
  proposedBy: Schema.String,
  createdAt: Schema.String,
  changeKind: Schema.Literal("factual", "mechanical"),
  proposalIds: Schema.Array(Schema.String),
  status: Schema.Literal("open", "accepted", "rejected", "superseded")
})

const VaultSnapshotSchema = Schema.Struct({
  version: Schema.Int.pipe(Schema.nonNegative()),
  heads: Schema.Array(VaultPageHeadSchema),
  revisions: Schema.Array(StoredRevisionRecordSchema),
  sources: Schema.Array(StoredSourceRecordSchema),
  proposals: Schema.Array(MemoryProposalSchema),
  proposalSets: Schema.optionalWith(Schema.Array(VaultProposalSetSchema), { default: () => [] }),
  events: Schema.Array(MemoryAuditEventSchema),
  retrievals: Schema.Array(RetrievalMetricSchema),
  sessionRetrievals: Schema.optionalWith(Schema.Array(SessionRetrievalMetricSchema), {
    default: () => []
  })
})

const VaultHistorySchema = Schema.Struct({
  proposals: Schema.Array(MemoryProposalSchema),
  proposalSets: Schema.Array(VaultProposalSetSchema),
  events: Schema.Array(MemoryAuditEventSchema),
  retrievals: Schema.Array(RetrievalMetricSchema),
  sessionRetrievals: Schema.Array(SessionRetrievalMetricSchema)
})

type VaultHistory = Schema.Schema.Type<typeof VaultHistorySchema>

const emptySnapshot = (): VaultSnapshot => ({
  version: 0,
  heads: [],
  revisions: [],
  sources: [],
  proposals: [],
  proposalSets: [],
  events: [],
  retrievals: [],
  sessionRetrievals: []
})

const SEARCH_WHITESPACE_PATTERN = /\s+/
const INVALID_SEARCH_TERM_PATTERN = /[^\p{L}\p{N}_-]+/gu

const decodeSnapshot = (value: unknown): VaultSnapshot =>
  Schema.decodeUnknownSync(VaultSnapshotSchema)(value)

const snapshotJson = (snapshot: VaultSnapshot): string => canonicalJson(snapshot)

const historyFor = (snapshot: VaultSnapshot): VaultHistory => ({
  proposals: snapshot.proposals,
  proposalSets: snapshot.proposalSets,
  events: snapshot.events,
  retrievals: snapshot.retrievals,
  sessionRetrievals: snapshot.sessionRetrievals
})

const decodeHistory = (value: string | null): VaultHistory => {
  if (value === null) return historyFor(emptySnapshot())
  return Schema.decodeUnknownSync(VaultHistorySchema)(JSON.parse(value))
}

export class InMemoryVaultState implements VaultStateStorage {
  private snapshot = emptySnapshot()
  private indexedRows: SearchProjection["rows"] = []
  private projectedPages = new Map<string, string>()
  private navigation: Pick<SearchProjection, "indexMarkdown" | "logMarkdown"> | undefined
  private retrievals = new Map<string, RetrievalMetric>()

  initialize(): Effect.Effect<void> {
    return Effect.void
  }

  load(): Effect.Effect<VaultSnapshot> {
    return Effect.sync(() => decodeSnapshot(JSON.parse(snapshotJson(this.snapshot))))
  }

  commit(
    expectedVersion: number,
    next: VaultSnapshot,
    projection: SearchProjection,
    pages: ReadonlyArray<MemoryPage>
  ): Effect.Effect<boolean> {
    return Effect.sync(() => {
      if (this.snapshot.version !== expectedVersion) return false
      this.snapshot = decodeSnapshot(JSON.parse(snapshotJson(next)))
      this.indexedRows = projection.rows
      this.projectedPages = new Map(pages.map((page) => [page.id, serializeMemoryMarkdown(page)]))
      this.navigation = {
        indexMarkdown: projection.indexMarkdown,
        logMarkdown: projection.logMarkdown
      }
      return true
    })
  }

  loadProjectedPages(pageIds?: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<MemoryPage>> {
    return Effect.sync(() => {
      const ids = pageIds ?? [...this.projectedPages.keys()]
      return ids.flatMap((pageId) => {
        const markdown = this.projectedPages.get(pageId)
        return markdown === undefined ? [] : [parseMemoryMarkdown(markdown)]
      })
    })
  }

  loadNavigation(): Effect.Effect<Pick<SearchProjection, "indexMarkdown" | "logMarkdown"> | undefined> {
    return Effect.sync(() => this.navigation)
  }

  recordRetrieval(metric: RetrievalMetric): Effect.Effect<void> {
    return Effect.sync(() => {
      this.retrievals.set(metric.id, metric)
      // Bound to the newest RETRIEVAL_RETENTION metrics so the table never grows
      // without limit (mirrors the SQLite prune).
      if (this.retrievals.size > RETRIEVAL_RETENTION) {
        this.retrievals = new Map(
          boundedRetrievals([...this.retrievals.values()], RETRIEVAL_RETENTION).map((entry) => [
            entry.id,
            entry
          ])
        )
      }
    })
  }

  listRetrievals(): Effect.Effect<ReadonlyArray<RetrievalMetric>> {
    return Effect.sync(() => [...this.retrievals.values()])
  }

  searchPageIds(query: string, limit: number): Effect.Effect<ReadonlyArray<string>> {
    return Effect.sync(() => {
      const normalized = query.toLocaleLowerCase("en-US")
      return this.indexedRows
        .filter((row) =>
          [row.path, row.title, row.body, row.aliases, row.tags].some((value) =>
            value.toLocaleLowerCase("en-US").includes(normalized)
          )
        )
        .slice(0, limit)
        .map((row) => row.pageId)
    })
  }
}

interface StateRow {
  readonly version: number
  readonly state_json: string
}

interface SearchRow {
  readonly page_id: string
}

interface ProjectedPageRow {
  readonly page_markdown: string
}

interface NavigationRow {
  readonly index_markdown: string
  readonly log_markdown: string
}

/**
 * Thrown inside {@link SqliteVaultState.commit}'s `transactionSync` closure when the
 * optimistic version check misses. `transactionSync` rolls back only on throw, so a
 * stale version — a normal, expected outcome — is signalled by throwing this marker
 * and translating it back into `false` outside the transaction. Any OTHER throw rolls
 * back and propagates as a real failure.
 */
const STALE_VAULT_VERSION: unique symbol = Symbol("SqliteVaultState.staleVersion")

export class SqliteVaultState implements VaultStateStorage {
  private readonly sql: SqlStorageLike

  constructor(private readonly storage: DurableObjectStorageLike) {
    this.sql = storage.sql
  }

  initialize(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS vault_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, state_json TEXT NOT NULL)"
      )
      this.sql.exec(
        // biome-ignore lint/security/noSecrets: this is a static FTS5 schema, not a credential.
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(page_id UNINDEXED, path, title, body, aliases, tags, tokenize='unicode61')"
      )
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS memory_pages (page_id TEXT PRIMARY KEY, page_markdown TEXT NOT NULL)"
      )
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS memory_navigation (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), index_markdown TEXT NOT NULL, log_markdown TEXT NOT NULL)"
      )
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS memory_retrievals (id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, query_hash TEXT NOT NULL, result_count INTEGER NOT NULL, duration_ms REAL NOT NULL)"
      )
      this.sql.exec(
        "INSERT OR IGNORE INTO vault_state(singleton, version, state_json) VALUES (1, 0, ?)",
        snapshotJson(emptySnapshot())
      )
    })
  }

  load(): Effect.Effect<VaultSnapshot, MemoryVaultError> {
    return Effect.suspend(() => {
      const row = this.sql
        .exec<StateRow>("SELECT version, state_json FROM vault_state WHERE singleton = 1")
        .toArray()[0]
      if (row === undefined) {
        return Effect.fail(
          new MemoryVaultError({ code: "not_found", message: "vault state was not initialized", status: 404 })
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(row.state_json)
      } catch (error) {
        return Effect.fail(
          new MemoryVaultError({ code: "invalid", message: `invalid persisted vault state: ${String(error)}` })
        )
      }
      const snapshot = decodeSnapshot(parsed)
      return Effect.succeed(
        snapshot.version === row.version ? snapshot : { ...snapshot, version: row.version }
      )
    })
  }

  // TODO(memory-scale): this rewrites the WHOLE FTS + page projection on every
  // commit — including metric-only and status-flip persists that leave page
  // bodies unchanged — and each caller first re-materializes every body via
  // loadPages(). At the 10k-page / 64KB-page target that is O(corpus) SQLite
  // churn per write inside a Durable Object. Make projection updates incremental
  // (upsert/delete only the affected pages) and derive dashboard/graph from the
  // stored projection instead of re-parsing every body per read. Tracked as a
  // dedicated follow-up; correctness is unaffected at current scale.
  private replaceProjection(
    projection: SearchProjection,
    pages: ReadonlyArray<MemoryPage>
  ): void {
    this.sql.exec("DELETE FROM memory_fts")
    this.sql.exec("DELETE FROM memory_pages")
    for (const row of projection.rows) {
      this.sql.exec(
        "INSERT INTO memory_fts(page_id, path, title, body, aliases, tags) VALUES (?, ?, ?, ?, ?, ?)",
        row.pageId,
        row.path,
        row.title,
        row.body,
        row.aliases,
        row.tags
      )
    }
    for (const page of pages) {
      this.sql.exec(
        "INSERT INTO memory_pages(page_id, page_markdown) VALUES (?, ?)",
        page.id,
        serializeMemoryMarkdown(page)
      )
    }
    this.sql.exec(
      "INSERT INTO memory_navigation(singleton, index_markdown, log_markdown) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET index_markdown = excluded.index_markdown, log_markdown = excluded.log_markdown",
      projection.indexMarkdown,
      projection.logMarkdown
    )
  }

  commit(
    expectedVersion: number,
    next: VaultSnapshot,
    projection: SearchProjection,
    pages: ReadonlyArray<MemoryPage>
  ): Effect.Effect<boolean> {
    // Durable-Object SQLite forbids explicit BEGIN/COMMIT/ROLLBACK via `sql.exec`,
    // so the atomic unit is bracketed by `transactionSync`: a synchronous closure
    // that commits on return and rolls back on throw. It stays inside ONE
    // `Effect.sync` thunk so the fiber never yields mid-commit — atomicity is
    // preserved exactly as the manual-transaction version had it.
    return Effect.sync(() => {
      try {
        this.storage.transactionSync(() => {
          const result = this.sql.exec(
            "UPDATE vault_state SET version = ?, state_json = ? WHERE singleton = 1 AND version = ?",
            next.version,
            snapshotJson(next),
            expectedVersion
          )
          // Optimistic-lock miss: throw the marker so `transactionSync` rolls the
          // whole unit back, then translate it into `false` below.
          if (result.rowsWritten !== 1) throw STALE_VAULT_VERSION
          this.replaceProjection(projection, pages)
        })
        return true
      } catch (error) {
        if (error === STALE_VAULT_VERSION) return false
        throw error
      }
    })
  }

  loadProjectedPages(
    pageIds?: ReadonlyArray<string>
  ): Effect.Effect<ReadonlyArray<MemoryPage> | undefined, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const rows = pageIds === undefined
        ? this.sql.exec<ProjectedPageRow>("SELECT page_markdown FROM memory_pages ORDER BY page_id").toArray()
        : pageIds.flatMap((pageId) =>
            this.sql
              .exec<ProjectedPageRow>("SELECT page_markdown FROM memory_pages WHERE page_id = ?", pageId)
              .toArray()
          )
      if (rows.length === 0) {
        const state = yield* this.load()
        if (state.heads.length > 0) return undefined
      }
      return rows.map((row) => parseMemoryMarkdown(row.page_markdown))
    })
  }

  loadNavigation(): Effect.Effect<Pick<SearchProjection, "indexMarkdown" | "logMarkdown"> | undefined> {
    return Effect.sync(() => {
      const row = this.sql
        .exec<NavigationRow>(
          "SELECT index_markdown, log_markdown FROM memory_navigation WHERE singleton = 1"
        )
        .toArray()[0]
      return row === undefined
        ? undefined
        : { indexMarkdown: row.index_markdown, logMarkdown: row.log_markdown }
    })
  }

  recordRetrieval(metric: RetrievalMetric): Effect.Effect<void> {
    return Effect.sync(() => {
      this.sql.exec(
        "INSERT OR IGNORE INTO memory_retrievals(id, occurred_at, query_hash, result_count, duration_ms) VALUES (?, ?, ?, ?, ?)",
        metric.id,
        metric.occurredAt,
        metric.queryHash,
        metric.resultCount,
        metric.durationMs
      )
      // Prune to the newest RETRIEVAL_RETENTION rows (newest by occurred_at, then id)
      // right after the insert, so the table — and the per-request dashboard fold that
      // reads it — stays bounded no matter how many searches run. A standalone bounded
      // DELETE is safe here because recordRetrieval is already its own write.
      this.sql.exec(
        "DELETE FROM memory_retrievals WHERE id NOT IN (SELECT id FROM memory_retrievals ORDER BY occurred_at DESC, id DESC LIMIT ?)",
        RETRIEVAL_RETENTION
      )
    })
  }

  listRetrievals(): Effect.Effect<ReadonlyArray<RetrievalMetric>> {
    return Effect.sync(() =>
      this.sql
        .exec<{
          readonly id: string
          readonly occurred_at: string
          readonly query_hash: string
          readonly result_count: number
          readonly duration_ms: number
        }>("SELECT id, occurred_at, query_hash, result_count, duration_ms FROM memory_retrievals ORDER BY occurred_at, id LIMIT ?", RETRIEVAL_RETENTION)
        .toArray()
        .map((row) => ({
          id: row.id,
          occurredAt: row.occurred_at,
          queryHash: row.query_hash,
          resultCount: row.result_count,
          durationMs: row.duration_ms
        }))
    )
  }

  searchPageIds(query: string, limit: number): Effect.Effect<ReadonlyArray<string> | undefined> {
    return Effect.sync(() => {
      const terms = query
        .normalize("NFKC")
        .split(SEARCH_WHITESPACE_PATTERN)
        .map((term) => term.replace(INVALID_SEARCH_TERM_PATTERN, ""))
        .filter((term) => term.length > 0)
        // FTS5 PREFIX form (`"term"*`) so partial words match, aligning the DO's
        // keyword prefilter with the substring scorer + InMemoryVaultState. Without
        // the trailing `*` a quoted term is an EXACT token match ('"ret"' never
        // matches the token 'retry'), so partial-word queries that pass against the
        // in-memory (substring) fake would return zero rows against the real DO.
        .map((term) => `"${term.replace(/"/g, '""')}"*`)
      if (terms.length === 0) return []
      try {
        return this.sql
          .exec<SearchRow>(
            "SELECT page_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?",
            terms.join(" AND "),
            limit
          )
          .toArray()
          .map((row) => row.page_id)
      } catch {
        return undefined
      }
    })
  }
}

const acceptedLog = (
  snapshot: VaultSnapshot
): ReadonlyArray<{ readonly occurredAt: string; readonly pageId: string; readonly revision: number }> =>
  snapshot.revisions.map((revision) => ({
    occurredAt: revision.acceptedAt,
    pageId: revision.pageId,
    revision: revision.revision
  }))

const uniqueById = <Value extends { readonly id: string }>(
  values: ReadonlyArray<Value>
): ReadonlyArray<Value> => {
  const byId = new Map<string, Value>()
  for (const value of values) byId.set(value.id, value)
  return [...byId.values()].sort((left, right) => compareText(left.id, right.id))
}

const MAX_SESSION_RETRIEVALS = 4_096

const boundedSessionRetrievals = (
  values: ReadonlyArray<SessionRetrievalMetric>
): ReadonlyArray<SessionRetrievalMetric> =>
  [...uniqueById(values)]
    .sort(
      (left, right) =>
        compareText(left.occurredAt, right.occurredAt) || compareText(left.id, right.id)
    )
    .slice(-MAX_SESSION_RETRIEVALS)

/**
 * Per-search retrieval metrics are ephemeral, privacy-safe analytics — never a
 * source of truth. They are bounded on all three growth vectors:
 *  - {@link RETRIEVAL_RETENTION}: newest rows kept in the DO SQLite `memory_retrievals`
 *    table (pruned on every insert), so per-request dashboard folds stay cheap.
 *  - {@link RETRIEVAL_DAY_CAP}: max metrics kept in each UTC-day R2 rollup object, so
 *    R2 grows by (bounded) day count, not by search volume.
 *  - {@link RETRIEVAL_REBUILD_DAYS}: newest day-rollups read by rebuildFromR2, so
 *    recovery time is bounded regardless of history length.
 */
export const RETRIEVAL_RETENTION = 2_000
export const RETRIEVAL_DAY_CAP = 500
export const RETRIEVAL_REBUILD_DAYS = 30

/** The UTC day a metric belongs to, as an R2-rollup `YYYY-MM-DD` key. */
const retrievalDayOf = (metric: RetrievalMetric): string => metric.occurredAt.slice(0, 10)

/** Newest-N retrieval metrics, deduped by id, ordered by (occurredAt, id). */
const boundedRetrievals = (
  values: ReadonlyArray<RetrievalMetric>,
  limit: number
): ReadonlyArray<RetrievalMetric> =>
  [...uniqueById(values)]
    .sort(
      (left, right) =>
        compareText(left.occurredAt, right.occurredAt) || compareText(left.id, right.id)
    )
    .slice(-Math.max(0, limit))

const RetrievalArraySchema = Schema.Array(RetrievalMetricSchema)
const decodeRetrievalArray = (value: string): ReadonlyArray<RetrievalMetric> =>
  Schema.decodeUnknownSync(RetrievalArraySchema)(JSON.parse(value))

const uniqueSourceRecords = (
  values: ReadonlyArray<StoredSourceRecord>
): ReadonlyArray<StoredSourceRecord> => {
  const byId = new Map<string, StoredSourceRecord>()
  for (const value of values) byId.set(value.source.id, value)
  return [...byId.values()].sort((left, right) => compareText(left.source.id, right.source.id))
}

const revisionForHead = (
  snapshot: VaultSnapshot,
  head: VaultPageHead
): StoredRevisionRecord => {
  const revision = snapshot.revisions.find((candidate) => candidate.id === head.revisionId)
  if (revision === undefined) {
    throw new MemoryVaultError({ code: "invalid", message: `head ${head.pageId} has no revision ${head.revisionId}` })
  }
  return revision
}

const pageCreatedEvent = (
  pageId: string,
  revisionId: string,
  actorId: string,
  occurredAt: string
): MemoryAuditEvent => ({
  id: `${revisionId}:page-created`,
  type: "page.created",
  actorId,
  occurredAt,
  pageId,
  revisionId,
  details: {}
})

const revisionCreatedEvent = (revision: StoredRevisionRecord): MemoryAuditEvent => ({
  id: `${revision.id}:revision-created`,
  type: "revision.created",
  actorId: revision.authorId,
  occurredAt: revision.acceptedAt,
  pageId: revision.pageId,
  revisionId: revision.id,
  details: { revision: String(revision.revision), contentHash: revision.contentHash }
})

export class TeamVault {
  /**
   * Serializes every mutation. A permit-1 semaphore preserves the previous
   * promise-chain mutex semantics EXACTLY — FIFO mutual exclusion, and the
   * permit is released on success, failure, or interruption.
   */
  private readonly mutex = Effect.unsafeMakeSemaphore(1)

  private constructor(
    readonly organizationId: string,
    private readonly state: VaultStateStorage,
    private readonly objects: MemoryR2Store,
    /**
     * Optional advisory vector sidecar. Present only when the Worker env carries a
     * turbopuffer key; absent means relatedness suggestions degrade to lexical.
     * Never consulted by search, the graph, or any export hash.
     */
    private readonly vectorLayer?: TurbopufferVectorLayer
  ) {}

  static create(
    organizationId: string,
    state: VaultStateStorage,
    bucket: R2BucketLike,
    vectorLayer?: TurbopufferVectorLayer
  ): Effect.Effect<TeamVault, MemoryVaultError> {
    return Effect.gen(function* () {
      yield* state.initialize()
      return new TeamVault(
        organizationId,
        state,
        new MemoryR2Store(organizationId, bucket),
        vectorLayer
      )
    })
  }

  private serialized<A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return this.mutex.withPermits(1)(operation)
  }

  private loadPages(
    snapshot: VaultSnapshot,
    pageIds?: ReadonlyArray<string>
  ): Effect.Effect<Array<MemoryPage>, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const projected = yield* this.state.loadProjectedPages(pageIds)
      if (projected !== undefined) return [...projected]
      return yield* Effect.promise(async () => {
        const requested = pageIds === undefined ? undefined : new Set(pageIds)
        const heads = [...snapshot.heads]
          .filter((head) => requested === undefined || requested.has(head.pageId))
          .sort((left, right) => compareText(left.pageId, right.pageId))
        const pages: Array<MemoryPage> = []
        const concurrency = 16
        for (let offset = 0; offset < heads.length; offset += concurrency) {
          pages.push(
            ...(await Promise.all(
              heads.slice(offset, offset + concurrency).map(async (head) =>
                parseMemoryPage(head.path, await this.objects.readMarkdown(head.markdownKey))
              )
            ))
          )
        }
        return pages
      })
    })
  }

  private sources(snapshot: VaultSnapshot): ReadonlyArray<MemorySource> {
    return snapshot.sources.map((record) => record.source)
  }

  private persist(
    current: VaultSnapshot,
    changes: Omit<VaultSnapshot, "version">,
    pages: ReadonlyArray<MemoryPage>
  ): Effect.Effect<VaultSnapshot, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const next: VaultSnapshot = { ...changes, version: current.version + 1 }
      const projection = buildSearchProjection(pages, acceptedLog(next))
      if (!(yield* this.state.commit(current.version, next, projection, pages))) {
        return yield* new MemoryVaultError({ code: "storage_conflict", message: "vault state changed concurrently", status: 409 })
      }
      yield* Effect.promise(() => this.objects.putHistory(next.version, canonicalJson(historyFor(next))))
      return next
    })
  }

  ingestSource(
    source: MemorySource,
    content: string,
    retrieval: MemoryRetrievalSummaryType = {
      searches: 0,
      reads: 0,
      navigation: 0,
      graphReads: 0,
      proposals: 0
    }
  ): Effect.Effect<StoredSourceRecord, MemoryVaultError> {
    return this.serialized(Effect.gen(this, function* () {
      const current = yield* this.state.load()
      const existing = current.sources.find((record) => record.source.id === source.id)
      const metric: SessionRetrievalMetric = {
        id: `session-retrieval:${source.id}`,
        occurredAt: source.retrievedAt ?? new Date().toISOString(),
        ...retrieval
      }
      if (existing !== undefined) {
        if ((yield* Effect.promise(() => this.objects.readSourceContent(existing))) === content) {
          if (!current.sessionRetrievals.some((candidate) => candidate.id === metric.id)) {
            const pages = yield* this.loadPages(current)
            yield* this.persist(
              current,
              {
                ...current,
                sessionRetrievals: boundedSessionRetrievals([
                  ...current.sessionRetrievals,
                  metric
                ])
              },
              pages
            )
          }
          return existing
        }
        return yield* new MemoryVaultError({ code: "conflict", message: `source id ${source.id} already exists`, status: 409 })
      }
      const stored = yield* Effect.promise(() => this.objects.putSource(source, content))
      const pages = yield* this.loadPages(current)
      yield* this.persist(
        current,
        {
          ...current,
          sources: uniqueSourceRecords([...current.sources, stored]),
          sessionRetrievals: boundedSessionRetrievals([...current.sessionRetrievals, metric])
        },
        pages
      )
      return stored
    }))
  }

  ingestAcceptedPage(input: IngestAcceptedPageInput): Effect.Effect<AcceptedPageResponse, MemoryVaultError> {
    return this.serialized(Effect.gen(this, function* () {
      const current = yield* this.state.load()
      const duplicateRevision = current.revisions.find((revision) => revision.id === input.revisionId)
      if (duplicateRevision !== undefined) {
        const head = current.heads.find((candidate) => candidate.revisionId === duplicateRevision.id)
        if (head === undefined) {
          return yield* new MemoryVaultError({ code: "conflict", message: `revision id ${input.revisionId} already exists`, status: 409 })
        }
        const markdown = yield* Effect.promise(() => this.objects.readMarkdown(duplicateRevision.markdownKey))
        if (serializeMemoryMarkdown(parseMemoryPage(head.path, markdown)) !== serializeMemoryMarkdown(parseMemoryPage(head.path, input.markdown))) {
          return yield* new MemoryVaultError({ code: "conflict", message: `revision id ${input.revisionId} already exists`, status: 409 })
        }
        return yield* this.acceptedPageResponse(current, head)
      }
      const candidate = parseMemoryMarkdown(input.markdown)
      if (candidate.revision !== 1) {
        return yield* new MemoryVaultError({ code: "invalid", message: "an initial accepted page must have revision 1" })
      }
      if (current.heads.some((head) => head.pageId === candidate.id)) {
        return yield* new MemoryVaultError({ code: "conflict", message: `page ${candidate.id} already exists; create a proposal`, status: 409 })
      }
      const existingPages = yield* this.loadPages(current)
      assertMemoryValid(
        { pages: [...existingPages, candidate], sources: this.sources(current) },
        { requireCitations: true }
      )
      const canonicalMarkdown = serializeMemoryMarkdown(candidate)
      const stored = yield* Effect.promise(() => this.objects.putAcceptedRevision(canonicalMarkdown, {
        id: input.revisionId,
        pageId: candidate.id,
        revision: 1,
        authorId: input.actorId,
        createdAt: input.createdAt,
        acceptedAt: input.createdAt
      }))
      const head: VaultPageHead = {
        pageId: candidate.id,
        path: candidate.path,
        title: candidate.title,
        revisionId: stored.id,
        revision: stored.revision,
        contentHash: stored.contentHash,
        markdownKey: stored.markdownKey,
        acceptedAt: stored.acceptedAt
      }
      const pages = [...existingPages, candidate]
      const events = uniqueById([
        ...current.events,
        pageCreatedEvent(candidate.id, stored.id, input.actorId, input.createdAt),
        revisionCreatedEvent(stored)
      ])
      const next = yield* this.persist(
        current,
        {
          ...current,
          heads: [...current.heads, head].sort((left, right) => compareText(left.pageId, right.pageId)),
          revisions: uniqueById([...current.revisions, stored]),
          events
        },
        pages
      )
      return yield* this.acceptedPageResponse(next, head)
    }))
  }

  createProposal(input: CreateProposalInput): Effect.Effect<MemoryProposal, MemoryVaultError> {
    return this.serialized(Effect.gen(this, function* () {
      const current = yield* this.state.load()
      const proposal: MemoryProposal = { ...input, status: "open" }
      const decoded = Schema.decodeUnknownSync(MemoryProposalSchema)(proposal)
      const existing = current.proposals.find((candidate) => candidate.id === input.id)
      if (existing !== undefined) {
        if (canonicalJson(existing) === canonicalJson(decoded)) return existing
        return yield* new MemoryVaultError({ code: "conflict", message: `proposal id ${input.id} already exists`, status: 409 })
      }
      const head = current.heads.find((candidate) => candidate.pageId === input.pageId)
      if (head === undefined) return yield* new MemoryVaultError({ code: "not_found", message: `page ${input.pageId} was not found`, status: 404 })
      if (head.revisionId !== input.baseRevisionId) {
        return yield* new MemoryVaultError({ code: "conflict", message: `proposal base ${input.baseRevisionId} is stale; current head is ${head.revisionId}`, status: 409 })
      }
      const parsed = parseMemoryPage(head.path, input.markdown)
      if (parsed.id !== input.pageId || parsed.revision !== head.revision + 1) {
        return yield* new MemoryVaultError({ code: "invalid", message: "proposal identity or revision number is invalid" })
      }
      const pages = yield* this.loadPages(current)
      assertMemoryValid(
        {
          pages: pages.map((page) => (page.id === parsed.id ? parsed : page)),
          sources: this.sources(current)
        },
        { requireCitations: true }
      )
      const event: MemoryAuditEvent = {
        id: `${input.id}:proposal-created`,
        type: "proposal.created",
        actorId: input.proposedBy,
        occurredAt: input.createdAt,
        pageId: input.pageId,
        proposalId: input.id,
        details: { baseRevisionId: input.baseRevisionId }
      }
      yield* this.persist(
        current,
        {
          ...current,
          proposals: uniqueById([...current.proposals, decoded]),
          events: uniqueById([...current.events, event])
        },
        pages
      )
      return decoded
    }))
  }

  createProposalSet(input: CreateProposalSetInput): Effect.Effect<VaultProposalSet, MemoryVaultError> {
    return this.serialized(Effect.gen(this, function* () {
      const current = yield* this.state.load()
      const pages = yield* this.loadPages(current)
      const prepared = prepareProposalSet(input, pages, current.heads, this.sources(current))
      const existing = current.proposalSets.find((candidate) => candidate.id === input.id)
      if (existing !== undefined) {
        if (proposalSetMatches(existing, current.proposals, prepared)) return existing
        return yield* new MemoryVaultError({ code: "conflict", message: `proposal set id ${input.id} already exists`, status: 409 })
      }
      if (current.proposals.some((proposal) => prepared.set.proposalIds.includes(proposal.id))) {
        return yield* new MemoryVaultError({ code: "conflict", message: `proposal ids for set ${input.id} already exist`, status: 409 })
      }
      const events = prepared.proposals.map(
        (proposal): MemoryAuditEvent => ({
          id: `${proposal.id}:proposal-created`,
          type: "proposal.created",
          actorId: proposal.proposedBy,
          occurredAt: proposal.createdAt,
          pageId: proposal.pageId,
          proposalId: proposal.id,
          details: {
            baseRevisionId: proposal.baseRevisionId,
            proposalSetId: prepared.set.id,
            workflowId: prepared.set.workflowId,
            sourceId: prepared.set.sourceId
          }
        })
      )
      yield* this.persist(
        current,
        {
          ...current,
          proposals: uniqueById([...current.proposals, ...prepared.proposals]),
          proposalSets: uniqueById([...current.proposalSets, prepared.set]),
          events: uniqueById([...current.events, ...events])
        },
        pages
      )
      return prepared.set
    }))
  }

  approveProposalSet(
    proposalSetId: string,
    reviewerId: string,
    acceptedAt: string
  ): Effect.Effect<ProposalSetApprovalResult, MemoryVaultError> {
    return this.serialized(Effect.gen(this, function* () {
      const current = yield* this.state.load()
      const proposalSet = current.proposalSets.find((candidate) => candidate.id === proposalSetId)
      if (proposalSet === undefined) {
        return yield* new MemoryVaultError({ code: "not_found", message: `proposal set ${proposalSetId} was not found`, status: 404 })
      }
      const setProposals = proposalSet.proposalIds.map((proposalId) => {
        const proposal = current.proposals.find((candidate) => candidate.id === proposalId)
        if (proposal === undefined) {
          throw new MemoryVaultError({ code: "invalid", message: `proposal set ${proposalSetId} is incomplete` })
        }
        return proposal
      })
      if (proposalSet.status === "accepted") {
        return {
          status: "accepted",
          proposalSetId,
          revisions: setProposals.map((proposal) => {
            const revision = current.revisions.find(
              (candidate) => candidate.id === `revision:${proposal.id}`
            )
            if (revision === undefined) {
              throw new MemoryVaultError({ code: "invalid", message: `accepted proposal ${proposal.id} has no revision` })
            }
            return {
              proposalId: proposal.id,
              pageId: proposal.pageId,
              revisionId: revision.id,
              revision: revision.revision
            }
          })
        }
      }

      const heads = new Map(current.heads.map((head) => [head.pageId, head]))
      const conflicts = setProposals.flatMap((proposal) => {
        const head = heads.get(proposal.pageId)
        const matchesBase = proposal.baseRevisionId === NEW_PAGE_BASE_REVISION_ID
          ? head === undefined
          : head?.revisionId === proposal.baseRevisionId
        return matchesBase
          ? []
          : [
              {
                pageId: proposal.pageId,
                expectedBaseRevisionId: proposal.baseRevisionId,
                currentHeadRevisionId: head?.revisionId ?? "missing"
              }
            ]
      })
      if (proposalSet.status !== "open" || conflicts.length > 0) {
        if (proposalSet.status === "open") {
          const supersededPages = yield* this.loadPages(current)
          yield* this.persist(
            current,
            {
              ...current,
              proposals: current.proposals.map((proposal) =>
                proposalSet.proposalIds.includes(proposal.id) && proposal.status === "open"
                  ? { ...proposal, status: "superseded" }
                  : proposal
              ),
              proposalSets: current.proposalSets.map((candidate) =>
                candidate.id === proposalSetId ? { ...candidate, status: "superseded" } : candidate
              )
            },
            supersededPages
          )
        }
        return { status: "conflict", proposalSetId, conflicts }
      }

      const pages = yield* this.loadPages(current)
      const prepared = prepareProposalSet(
        {
          id: proposalSet.id,
          workflowId: proposalSet.workflowId,
          sourceId: proposalSet.sourceId,
          proposedBy: proposalSet.proposedBy,
          createdAt: proposalSet.createdAt,
          changeKind: proposalSet.changeKind,
          drafts: setProposals.map((proposal) => ({
            pageId: proposal.pageId,
            baseRevisionId: proposal.baseRevisionId,
            ...(proposal.path === undefined ? {} : { path: proposal.path }),
            markdown: proposal.markdown,
            ...(proposal.summary === undefined ? {} : { summary: proposal.summary })
          }))
        },
        pages,
        current.heads,
        this.sources(current)
      )
      const candidateById = new Map(prepared.candidatePages.map((page) => [page.id, page]))
      const storedRevisions: Array<StoredRevisionRecord> = []
      for (const proposal of setProposals) {
        const head = heads.get(proposal.pageId)
        const candidate = candidateById.get(proposal.pageId)
        if (candidate === undefined) {
          return yield* new MemoryVaultError({ code: "invalid", message: `proposal page ${proposal.pageId} disappeared` })
        }
        if (head === undefined && proposal.baseRevisionId !== NEW_PAGE_BASE_REVISION_ID) {
          return yield* new MemoryVaultError({ code: "invalid", message: `proposal page ${proposal.pageId} lost its accepted head` })
        }
        storedRevisions.push(
          yield* Effect.promise(() => this.objects.putAcceptedRevision(serializeMemoryMarkdown(candidate), {
            id: `revision:${proposal.id}`,
            pageId: proposal.pageId,
            revision: candidate.revision,
            ...(head === undefined ? {} : { parentRevisionId: head.revisionId }),
            authorId: proposal.proposedBy,
            createdAt: proposal.createdAt,
            acceptedAt,
            publicationId: proposalSet.id
          }))
        )
      }
      yield* Effect.promise(() => this.objects.putPublicationCommit({
        id: proposalSet.id,
        revisionIds: storedRevisions.map((revision) => revision.id),
        acceptedAt
      }))

      const storedByPage = new Map(storedRevisions.map((revision) => [revision.pageId, revision]))
      const updatedHeads = current.heads
        .map((head): VaultPageHead => {
          const revision = storedByPage.get(head.pageId)
          const candidate = candidateById.get(head.pageId)
          return revision === undefined || candidate === undefined
            ? head
            : {
                pageId: candidate.id,
                path: candidate.path,
                title: candidate.title,
                revisionId: revision.id,
                revision: revision.revision,
                contentHash: revision.contentHash,
                markdownKey: revision.markdownKey,
                acceptedAt
              }
        })
      const existingHeadIds = new Set(updatedHeads.map((head) => head.pageId))
      const createdHeads = storedRevisions.flatMap((revision): ReadonlyArray<VaultPageHead> => {
        if (existingHeadIds.has(revision.pageId)) return []
        const candidate = candidateById.get(revision.pageId)
        if (candidate === undefined) return []
        return [{
          pageId: candidate.id,
          path: candidate.path,
          title: candidate.title,
          revisionId: revision.id,
          revision: revision.revision,
          contentHash: revision.contentHash,
          markdownKey: revision.markdownKey,
          acceptedAt
        }]
      })
      const nextHeads = [...updatedHeads, ...createdHeads].sort((left, right) =>
        compareText(left.pageId, right.pageId)
      )
      const acceptedEvents = setProposals.map((proposal): MemoryAuditEvent => {
        const revisionId = `revision:${proposal.id}`
        return {
          id: `${proposal.id}:proposal-accepted`,
          type: "proposal.accepted",
          actorId: reviewerId,
          occurredAt: acceptedAt,
          pageId: proposal.pageId,
          proposalId: proposal.id,
          revisionId,
          details: {
            baseRevisionId: proposal.baseRevisionId,
            proposalSetId: proposalSet.id
          }
        }
      })
      yield* this.persist(
        current,
        {
          ...current,
          heads: nextHeads,
          revisions: uniqueById([...current.revisions, ...storedRevisions]),
          proposals: current.proposals.map((proposal) =>
            proposalSet.proposalIds.includes(proposal.id)
              ? { ...proposal, status: "accepted" }
              : proposal
          ),
          proposalSets: current.proposalSets.map((candidate) =>
            candidate.id === proposalSet.id ? { ...candidate, status: "accepted" } : candidate
          ),
          events: uniqueById([
            ...current.events,
            ...createdHeads.map((head) =>
              pageCreatedEvent(head.pageId, head.revisionId, reviewerId, acceptedAt)
            ),
            ...storedRevisions.map(revisionCreatedEvent),
            ...acceptedEvents
          ])
        },
        prepared.candidatePages
      )
      return {
        status: "accepted",
        proposalSetId,
        revisions: storedRevisions.map((revision) => ({
          proposalId: revision.id.slice("revision:".length),
          pageId: revision.pageId,
          revisionId: revision.id,
          revision: revision.revision
        }))
      }
    }))
  }

  rejectProposalSet(
    proposalSetId: string,
    reviewerId: string,
    rejectedAt: string
  ): Effect.Effect<VaultProposalSet, MemoryVaultError> {
    return this.serialized(Effect.gen(this, function* () {
      const current = yield* this.state.load()
      const proposalSet = current.proposalSets.find((candidate) => candidate.id === proposalSetId)
      if (proposalSet === undefined) {
        return yield* new MemoryVaultError({ code: "not_found", message: `proposal set ${proposalSetId} was not found`, status: 404 })
      }
      if (proposalSet.status !== "open") return proposalSet
      const rejected: VaultProposalSet = { ...proposalSet, status: "rejected" }
      const events = current.proposals
        .filter((proposal) => proposalSet.proposalIds.includes(proposal.id))
        .map(
          (proposal): MemoryAuditEvent => ({
            id: `${proposal.id}:proposal-rejected`,
            type: "proposal.rejected",
            actorId: reviewerId,
            occurredAt: rejectedAt,
            pageId: proposal.pageId,
            proposalId: proposal.id,
            details: { baseRevisionId: proposal.baseRevisionId, proposalSetId }
          })
        )
      const rejectedPages = yield* this.loadPages(current)
      yield* this.persist(
        current,
        {
          ...current,
          proposals: current.proposals.map((proposal) =>
            proposalSet.proposalIds.includes(proposal.id)
              ? { ...proposal, status: "rejected" }
              : proposal
          ),
          proposalSets: current.proposalSets.map((candidate) =>
            candidate.id === proposalSetId ? rejected : candidate
          ),
          events: uniqueById([...current.events, ...events])
        },
        rejectedPages
      )
      return rejected
    }))
  }

  approveProposal(proposalId: string, reviewerId: string, acceptedAt: string): Effect.Effect<ApprovalResult, MemoryVaultError> {
    return this.serialized(Effect.gen(this, function* () {
      const current = yield* this.state.load()
      const proposal = current.proposals.find((candidate) => candidate.id === proposalId)
      if (proposal === undefined) return yield* new MemoryVaultError({ code: "not_found", message: `proposal ${proposalId} was not found`, status: 404 })
      const head = current.heads.find((candidate) => candidate.pageId === proposal.pageId)
      if (head === undefined) return yield* new MemoryVaultError({ code: "not_found", message: `page ${proposal.pageId} was not found`, status: 404 })
      if (proposal.status === "accepted") {
        const revision = current.revisions.find((candidate) => candidate.id === `revision:${proposal.id}`)
        if (revision === undefined) return yield* new MemoryVaultError({ code: "invalid", message: "accepted proposal revision is missing" })
        return {
          status: "accepted",
          proposalId,
          pageId: proposal.pageId,
          revisionId: revision.id,
          revision: revision.revision
        }
      }
      if (proposal.status !== "open" || head.revisionId !== proposal.baseRevisionId) {
        const proposals = current.proposals.map((candidate): MemoryProposal =>
          candidate.id === proposal.id && candidate.status === "open"
            ? { ...candidate, status: "superseded" }
            : candidate
        )
        if (canonicalJson(proposals) !== canonicalJson(current.proposals)) {
          const supersededPages = yield* this.loadPages(current)
          yield* this.persist(current, { ...current, proposals }, supersededPages)
        }
        return {
          status: "conflict",
          proposalId,
          pageId: proposal.pageId,
          expectedBaseRevisionId: proposal.baseRevisionId,
          currentHeadRevisionId: head.revisionId
        }
      }
      const pages = yield* this.loadPages(current)
      const candidate = parseMemoryPage(head.path, proposal.markdown)
      if (candidate.id !== proposal.pageId || candidate.revision !== head.revision + 1) {
        return yield* new MemoryVaultError({ code: "invalid", message: "proposal identity or revision number is invalid" })
      }
      const acceptedPages = pages.map((page) => (page.id === candidate.id ? candidate : page))
      assertMemoryValid(
        { pages: acceptedPages, sources: this.sources(current) },
        { requireCitations: true }
      )
      const revisionId = `revision:${proposal.id}`
      const stored = yield* Effect.promise(() => this.objects.putAcceptedRevision(serializeMemoryMarkdown(candidate), {
        id: revisionId,
        pageId: candidate.id,
        revision: candidate.revision,
        parentRevisionId: head.revisionId,
        authorId: proposal.proposedBy,
        createdAt: proposal.createdAt,
        acceptedAt
      }))
      const nextHead: VaultPageHead = {
        pageId: candidate.id,
        path: candidate.path,
        title: candidate.title,
        revisionId: stored.id,
        revision: stored.revision,
        contentHash: stored.contentHash,
        markdownKey: stored.markdownKey,
        acceptedAt
      }
      const acceptedProposal: MemoryProposal = { ...proposal, status: "accepted" }
      const acceptedEvent: MemoryAuditEvent = {
        id: `${proposal.id}:proposal-accepted`,
        type: "proposal.accepted",
        actorId: reviewerId,
        occurredAt: acceptedAt,
        pageId: candidate.id,
        proposalId: proposal.id,
        revisionId: stored.id,
        details: { baseRevisionId: proposal.baseRevisionId }
      }
      yield* this.persist(
        current,
        {
          ...current,
          heads: current.heads
            .map((candidateHead) => (candidateHead.pageId === candidate.id ? nextHead : candidateHead))
            .sort((left, right) => compareText(left.pageId, right.pageId)),
          revisions: uniqueById([...current.revisions, stored]),
          proposals: current.proposals.map((candidateProposal) =>
            candidateProposal.id === proposal.id ? acceptedProposal : candidateProposal
          ),
          events: uniqueById([...current.events, revisionCreatedEvent(stored), acceptedEvent])
        },
        acceptedPages
      )
      return {
        status: "accepted",
        proposalId,
        pageId: proposal.pageId,
        revisionId,
        revision: stored.revision
      }
    }))
  }

  rejectProposal(proposalId: string, reviewerId: string, rejectedAt: string): Effect.Effect<MemoryProposal, MemoryVaultError> {
    return this.serialized(Effect.gen(this, function* () {
      const current = yield* this.state.load()
      const proposal = current.proposals.find((candidate) => candidate.id === proposalId)
      if (proposal === undefined) return yield* new MemoryVaultError({ code: "not_found", message: `proposal ${proposalId} was not found`, status: 404 })
      if (proposal.status !== "open") return proposal
      const rejected: MemoryProposal = { ...proposal, status: "rejected" }
      const event: MemoryAuditEvent = {
        id: `${proposal.id}:proposal-rejected`,
        type: "proposal.rejected",
        actorId: reviewerId,
        occurredAt: rejectedAt,
        pageId: proposal.pageId,
        proposalId: proposal.id,
        details: { baseRevisionId: proposal.baseRevisionId }
      }
      const rejectedPages = yield* this.loadPages(current)
      yield* this.persist(
        current,
        {
          ...current,
          proposals: current.proposals.map((candidate) =>
            candidate.id === proposal.id ? rejected : candidate
          ),
          events: uniqueById([...current.events, event])
        },
        rejectedPages
      )
      return rejected
    }))
  }

  private acceptedPageResponse(
    snapshot: VaultSnapshot,
    head: VaultPageHead
  ): Effect.Effect<AcceptedPageResponse, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const revision = revisionForHead(snapshot, head)
      const page = parseMemoryPage(head.path, yield* Effect.promise(() => this.objects.readMarkdown(head.markdownKey)))
      return {
        page,
        revision,
        sourceIds: [
          ...new Set([
            ...page.sources.map((source) => source.id),
            ...page.citations.map((citation) => citation.sourceId)
          ])
        ].sort(compareText),
        citationIds: page.citations.map((citation) => citation.id).sort(compareText)
      }
    })
  }

  readPage(pageId: string): Effect.Effect<ReadPageResponse, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const snapshot = yield* this.state.load()
      const head = snapshot.heads.find((candidate) => candidate.pageId === pageId)
      if (head === undefined) return yield* new MemoryVaultError({ code: "not_found", message: `page ${pageId} was not found`, status: 404 })
      const accepted = yield* this.acceptedPageResponse(snapshot, head)
      const backlinks = buildBacklinkIndex(yield* this.loadPages(snapshot))[pageId] ?? []
      return { ...accepted, backlinks }
    })
  }

  listPages(): Effect.Effect<ReadonlyArray<VaultPageHead>, MemoryVaultError> {
    return Effect.map(this.state.load(), (snapshot) =>
      [...snapshot.heads].sort((left, right) => compareText(left.path, right.path))
    )
  }

  listSources(): Effect.Effect<ReadonlyArray<MemorySource>, MemoryVaultError> {
    return Effect.map(this.state.load(), (snapshot) =>
      [...this.sources(snapshot)].sort((left, right) => compareText(left.id, right.id))
    )
  }

  readSource(sourceId: string): Effect.Effect<StoredSourceResponse, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const record = (yield* this.state.load()).sources.find((candidate) => candidate.source.id === sourceId)
      if (record === undefined) {
        return yield* new MemoryVaultError({ code: "not_found", message: `source ${sourceId} was not found`, status: 404 })
      }
      return {
        source: record.source,
        contentHash: record.contentHash,
        content: yield* Effect.promise(() => this.objects.readSourceContent(record))
      }
    })
  }

  getProposal(proposalId: string): Effect.Effect<MemoryProposal, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const proposal = (yield* this.state.load()).proposals.find((candidate) => candidate.id === proposalId)
      if (proposal === undefined) return yield* new MemoryVaultError({ code: "not_found", message: `proposal ${proposalId} was not found`, status: 404 })
      return proposal
    })
  }

  getProposalSet(proposalSetId: string): Effect.Effect<VaultProposalSet, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const proposalSet = (yield* this.state.load()).proposalSets.find(
        (candidate) => candidate.id === proposalSetId
      )
      if (proposalSet === undefined) {
        return yield* new MemoryVaultError({ code: "not_found", message: `proposal set ${proposalSetId} was not found`, status: 404 })
      }
      return proposalSet
    })
  }

  listProposalSets(limit = 50): Effect.Effect<ReadonlyArray<VaultProposalSet & {
    readonly pages: ReadonlyArray<MemoryProposal>
  }>, MemoryVaultError> {
    return Effect.map(this.state.load(), (snapshot) =>
      [...snapshot.proposalSets]
        .sort(
          (left, right) =>
            compareText(right.createdAt, left.createdAt) || compareText(left.id, right.id)
        )
        .slice(0, Math.max(1, Math.min(100, Math.floor(limit))))
        .map((set) => ({
          ...set,
          pages: set.proposalIds.flatMap((proposalId) => {
            const proposal = snapshot.proposals.find((candidate) => candidate.id === proposalId)
            return proposal === undefined ? [] : [proposal]
          })
        }))
    )
  }

  search(query: string, limit = 20, occurredAt = new Date().toISOString()): Effect.Effect<VaultSearchResponse, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const startedAt = performance.now()
      const snapshot = yield* this.state.load()
      const candidatePageIds = yield* this.state.searchPageIds(query, Math.max(limit * 4, 100))
      const pages = yield* this.loadPages(snapshot, candidatePageIds)
      const revisionIdByPageId = new Map(
        snapshot.heads.map((head) => [head.pageId, head.revisionId])
      )
      const response = searchAcceptedPages(pages, query, revisionIdByPageId, limit)
      const metric: RetrievalMetric = {
        id: `retrieval:${crypto.randomUUID()}`,
        occurredAt,
        queryHash: yield* Effect.promise(() => sha256ContentHash(query.normalize("NFKC").toLocaleLowerCase("en-US"))),
        resultCount: response.results.length,
        durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000)
      }
      // Persist the metric into the bounded, MUTABLE per-UTC-day R2 rollup rather
      // than a fresh immutable object per search: read the day's rollup, merge this
      // metric, cap to the newest RETRIEVAL_DAY_CAP, and overwrite. This keeps R2
      // durable (so a rebuild onto a fresh DO still recovers analytics) while
      // bounding R2 growth to one capped object per day. A lost metric under
      // concurrent same-day RMW is acceptable — these are ephemeral analytics.
      const day = retrievalDayOf(metric)
      const existing = yield* Effect.promise(() => this.objects.readRetrievalDay(day))
      const merged = boundedRetrievals(
        [...(existing === null ? [] : decodeRetrievalArray(existing)), metric],
        RETRIEVAL_DAY_CAP
      )
      yield* Effect.promise(() => this.objects.putRetrievalDay(day, canonicalJson(merged)))
      yield* this.state.recordRetrieval(metric)
      return response
    })
  }

  navigation(): Effect.Effect<Pick<SearchProjection, "indexMarkdown" | "logMarkdown">, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const stored = yield* this.state.loadNavigation()
      if (stored !== undefined) return stored
      const snapshot = yield* this.state.load()
      const projection = buildSearchProjection(yield* this.loadPages(snapshot), acceptedLog(snapshot))
      return { indexMarkdown: projection.indexMarkdown, logMarkdown: projection.logMarkdown }
    })
  }

  compilerContext(claims: ReadonlyArray<string>): Effect.Effect<CompilerVaultContext, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const snapshot = yield* this.state.load()
      const candidateIds = new Set<string>()
      for (const claim of claims.slice(0, 32)) {
        for (const pageId of (yield* this.state.searchPageIds(claim, 12)) ?? []) {
          candidateIds.add(pageId)
          if (candidateIds.size >= 48) break
        }
        if (candidateIds.size >= 48) break
      }
      const candidatePages = yield* this.loadPages(snapshot, [...candidateIds])
      const projectedPages = (yield* this.state.loadProjectedPages()) ?? []
      const schemaPages = projectedPages
        .filter((page) =>
          page.tags.includes("schema") || page.metadata.kind === "schema" || page.metadata.schema === true
        )
        .slice(0, 8)
      const heads = new Map(snapshot.heads.map((head) => [head.pageId, head]))
      const navigation = yield* this.navigation()
      return {
        candidates: candidatePages.flatMap((page) => {
          const head = heads.get(page.id)
          return head === undefined ? [] : [{ page, revisionId: head.revisionId }]
        }),
        schemaPages,
        indexMarkdown: navigation.indexMarkdown.slice(0, 32_000)
      }
    })
  }

  exportVault(): Effect.Effect<VaultExport, MemoryVaultError> {
    return Effect.gen(this, function* () {
    const snapshot = yield* this.state.load()
    const heads = [...snapshot.heads].sort((left, right) => compareText(left.path, right.path))
    const pages = yield* this.loadPages(snapshot)
    const navigation = buildSearchProjection(pages, acceptedLog(snapshot))
    const pageFiles = yield* Effect.promise(() => Promise.all(
      heads.map(async (head) => ({
        path: head.path,
        content: await this.objects.readMarkdown(head.markdownKey)
      }))
    ))
    return {
      format: "jingler-obsidian-vault",
      version: 1,
      files: [
        { path: ".obsidian/app.json", content: canonicalJson({ useMarkdownLinks: false }) },
        {
          path: "_jingler/manifest.json",
          content: canonicalJson({
            format: "jingler-obsidian-vault",
            version: 1,
            organizationId: this.objects.organizationId,
            pages: heads.map(({ pageId, path, revisionId, revision, contentHash }) => ({
              pageId,
              path,
              revisionId,
              revision,
              contentHash
            }))
          })
        },
        { path: "_jingler/Index.md", content: navigation.indexMarkdown },
        { path: "_jingler/Activity Log.md", content: navigation.logMarkdown },
        ...pageFiles
      ]
    }
    })
  }

  graph(
    options: { readonly limit?: number; readonly cursor?: number },
    asOf?: string
  ): Effect.Effect<VaultGraphView, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const snapshot = yield* this.state.load()
      const pages = yield* this.loadPages(snapshot)
      return buildBoundedGraphView(pages, this.sources(snapshot), options, {
        acceptedAtByPageId: new Map(snapshot.heads.map((head) => [head.pageId, head.acceptedAt])),
        ...(asOf === undefined ? {} : { now: asOf })
      })
    })
  }

  neighborhood(nodeId: string, limit?: number, asOf?: string): Effect.Effect<VaultGraphView, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const snapshot = yield* this.state.load()
      return buildGraphNeighborhood(
        yield* this.loadPages(snapshot),
        this.sources(snapshot),
        nodeId,
        limit,
        {
          acceptedAtByPageId: new Map(snapshot.heads.map((head) => [head.pageId, head.acceptedAt])),
          ...(asOf === undefined ? {} : { now: asOf })
        }
      )
    })
  }

  edgeEvidence(edgeId: string): Effect.Effect<VaultGraphEvidenceResponse, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const snapshot = yield* this.state.load()
      const evidence = findGraphEdgeEvidence(
        yield* this.loadPages(snapshot),
        this.sources(snapshot),
        edgeId
      )
      if (evidence === undefined) return yield* new MemoryVaultError({ code: "not_found", message: `edge ${edgeId} was not found`, status: 404 })
      return evidence
    })
  }

  /**
   * Advisory "related pages" suggestions — deterministic lexical relatedness,
   * augmented with turbopuffer nearest-neighbours when a vector layer is
   * configured. This is strictly separate from the graph/edge endpoints: it
   * returns hints only, never accepted edges, and touches no reproducible hash.
   */
  suggestions(
    policy: SuggestionPolicy = SUGGESTION_POLICY_DEFAULT,
    pageId?: string
  ): Effect.Effect<VaultSuggestionsResponse, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const snapshot = yield* this.state.load()
      const pages = yield* this.loadPages(snapshot)
      const graph = buildMemoryGraph(pages, this.sources(snapshot))
      let neighbors: ReadonlyArray<TurbopufferNeighbor> = []
      let embeddingModel = "none"
      let vectorSource: "turbopuffer" | "lexical" = "lexical"
      const layer = this.vectorLayer
      if (layer !== undefined && pages.length > 0) {
        // QUERY-ONLY. This read path NEVER embeds accepted snippets or upserts
        // vectors — namespace reconciliation is owned by the durable
        // MemoryVectorIngestWorkflow, triggered on accepted publication and swept
        // by cron. Here we only embed the query snippets and run the ANN query.
        //
        // Best-effort: ANY OpenAI or turbopuffer failure (embedder throw, missing
        // namespace, network error) is caught here and the endpoint degrades to
        // lexical-only — it MUST NEVER surface as a 500. The R2 store remains the
        // source of truth; the vector namespace is rebuildable.
        const vector = yield* Effect.gen(function* () {
          // Read nearest neighbours over whatever the ingest workflow has already
          // reconciled into the namespace (an empty/stale namespace just yields no
          // embedding neighbours; suggestions then degrade to the lexical pass).
          const found = yield* layer.allRelatedness(pages, Math.max(policy.topK, 1))
          return {
            neighbors: found,
            embeddingModel: layer.embeddingModel,
            vectorSource: "turbopuffer" as const
          }
        }).pipe(
          Effect.catchAllCause(() =>
            Effect.succeed({
              neighbors: [] as ReadonlyArray<TurbopufferNeighbor>,
              embeddingModel: "none",
              vectorSource: "lexical" as const
            })
          )
        )
        neighbors = vector.neighbors
        embeddingModel = vector.embeddingModel
        vectorSource = vector.vectorSource
      }
      return {
        version: 1,
        policy,
        vectorSource,
        suggestions: combineSuggestions({
          pages,
          graph,
          policy,
          neighbors,
          embeddingModel,
          ...(pageId === undefined ? {} : { pageId })
        })
      }
    })
  }

  dashboard(asOf: string, range: string = "all"): Effect.Effect<VaultDashboardSummary, MemoryVaultError> {
    return Effect.gen(this, function* () {
      const snapshot = yield* this.state.load()
      const retrievals = uniqueById([...snapshot.retrievals, ...(yield* this.state.listRetrievals())])
      return buildVaultDashboardSummary(
        {
          pages: yield* this.loadPages(snapshot),
          sourceCount: snapshot.sources.length,
          revisions: snapshot.revisions,
          proposals: snapshot.proposals,
          events: snapshot.events,
          heads: snapshot.heads,
          retrievals,
          sessionRetrievals: snapshot.sessionRetrievals
        },
        asOf,
        range
      )
    })
  }

  rebuildFromR2(): Effect.Effect<RebuildResult, MemoryVaultError> {
    return this.serialized(Effect.gen(this, function* () {
      const current = yield* this.state.load()
      const publicationRecords = yield* Effect.promise(() => this.objects.listPublicationRecords())
      const storedRevisions = yield* Effect.promise(() => this.objects.listRevisionRecords())
      const revisionById = new Map(storedRevisions.map((revision) => [revision.id, revision]))
      const completePublications = new Map(
        publicationRecords.flatMap((publication) => {
          const complete = publication.revisionIds.every((revisionId) => {
            const revision = revisionById.get(revisionId)
            return revision?.publicationId === publication.id
          })
          return complete ? [[publication.id, new Set(publication.revisionIds)] as const] : []
        })
      )
      const revisions = uniqueById(
        storedRevisions.filter((revision) => {
          if (revision.publicationId === undefined) return true
          return completePublications.get(revision.publicationId)?.has(revision.id) === true
        })
      )
      const sources = uniqueSourceRecords(yield* Effect.promise(() => this.objects.listSourceRecords()))
      const history = decodeHistory(yield* Effect.promise(() => this.objects.readLatestHistorySnapshot()))
      // Recover retrieval analytics from the newest RETRIEVAL_REBUILD_DAYS R2 day
      // rollups only, so recovery reads a bounded number of objects regardless of
      // history length. Each rollup is itself an array capped at RETRIEVAL_DAY_CAP.
      const retrievals = boundedRetrievals(
        [
          ...history.retrievals,
          ...(yield* Effect.promise(() => this.objects.listRetrievalDays(RETRIEVAL_REBUILD_DAYS))).flatMap(
            (value) => decodeRetrievalArray(value)
          )
        ],
        RETRIEVAL_REBUILD_DAYS * RETRIEVAL_DAY_CAP
      )
      const latestByPage = new Map<string, StoredRevisionRecord>()
      for (const revision of revisions) {
        const currentHead = latestByPage.get(revision.pageId)
        if (
          currentHead === undefined ||
          revision.revision > currentHead.revision ||
          (revision.revision === currentHead.revision && compareText(revision.id, currentHead.id) > 0)
        ) {
          latestByPage.set(revision.pageId, revision)
        }
      }
      const pages = yield* Effect.promise(() => Promise.all(
        [...latestByPage.values()]
          .sort((left, right) => compareText(left.pageId, right.pageId))
          .map(async (revision) => parseMemoryMarkdown(await this.objects.readMarkdown(revision.markdownKey)))
      ))
      assertMemoryValid({ pages, sources: sources.map((record) => record.source) })
      const pageById = new Map(pages.map((page) => [page.id, page]))
      const heads = [...latestByPage.values()]
        .map((revision): VaultPageHead => {
          const page = pageById.get(revision.pageId)
          if (page === undefined) throw new MemoryVaultError({ code: "invalid", message: `rebuilt page ${revision.pageId} is missing` })
          return {
            pageId: page.id,
            path: page.path,
            title: page.title,
            revisionId: revision.id,
            revision: revision.revision,
            contentHash: revision.contentHash,
            markdownKey: revision.markdownKey,
            acceptedAt: revision.acceptedAt
          }
        })
        .sort((left, right) => compareText(left.pageId, right.pageId))
      const firstRevisionByPage = new Map<string, StoredRevisionRecord>()
      for (const revision of revisions) {
        const first = firstRevisionByPage.get(revision.pageId)
        if (first === undefined || revision.revision < first.revision) {
          firstRevisionByPage.set(revision.pageId, revision)
        }
      }
      const rebuiltRevisionIds = new Set(revisions.map((revision) => revision.id))
      const retainedProposals = history.proposals.filter(
        (proposal) =>
          proposal.status !== "accepted" || rebuiltRevisionIds.has(`revision:${proposal.id}`)
      )
      const retainedProposalIds = new Set(retainedProposals.map((proposal) => proposal.id))
      const retainedProposalSets = history.proposalSets.filter((proposalSet) =>
        proposalSet.proposalIds.every((proposalId) => retainedProposalIds.has(proposalId))
      )
      const events = uniqueById([
        ...revisions.map(revisionCreatedEvent),
        ...[...firstRevisionByPage.values()].map((revision) =>
          pageCreatedEvent(revision.pageId, revision.id, revision.authorId, revision.acceptedAt)
        ),
        ...history.events.filter(
          (event) => event.type !== "page.created" && event.type !== "revision.created"
        )
      ])
      yield* this.persist(
        current,
        {
          heads,
          revisions,
          sources,
          proposals: retainedProposals,
          proposalSets: retainedProposalSets,
          events,
          retrievals,
          sessionRetrievals: history.sessionRetrievals
        },
        pages
      )
      return { pages: pages.length, revisions: revisions.length, sources: sources.length }
    }))
  }

  /** Test/support hook for verifying deterministic aggregate inputs without exposing it over HTTP. */
  snapshot(): Effect.Effect<VaultSnapshot, MemoryVaultError> {
    return this.state.load()
  }
}
