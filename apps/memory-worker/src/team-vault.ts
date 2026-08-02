import {
  MemoryRetrievalSummary,
  type MemoryRetrievalSummary as MemoryRetrievalSummaryType
} from "@jingler/core"
import {
  MemoryAuditEvent as MemoryAuditEventSchema,
  MemoryProposal as MemoryProposalSchema,
  MemorySource as MemorySourceSchema,
  assertMemoryValid,
  canonicalJson,
  parseMemoryMarkdown,
  parseMemoryPage,
  serializeMemoryMarkdown,
  type MemoryAuditEvent,
  type MemoryPage,
  type MemoryProposal,
  type MemorySource
} from "@jingler/memory"
import { Schema } from "effect"
import {
  buildVaultDashboardSummary,
  type RetrievalMetric,
  type SessionRetrievalMetric,
  type VaultDashboardSummary
} from "./analytics.js"
import type { R2BucketLike, SqlStorageLike } from "./env.js"
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
  initialize(): Promise<void>
  load(): Promise<VaultSnapshot>
  commit(
    expectedVersion: number,
    next: VaultSnapshot,
    projection: SearchProjection,
    pages: ReadonlyArray<MemoryPage>
  ): Promise<boolean>
  loadProjectedPages(pageIds?: ReadonlyArray<string>): Promise<ReadonlyArray<MemoryPage> | undefined>
  loadNavigation(): Promise<Pick<SearchProjection, "indexMarkdown" | "logMarkdown"> | undefined>
  searchPageIds(query: string, limit: number): Promise<ReadonlyArray<string> | undefined>
  recordRetrieval(metric: RetrievalMetric): Promise<void>
  listRetrievals(): Promise<ReadonlyArray<RetrievalMetric>>
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

export class MemoryVaultError extends Error {
  override readonly name = "MemoryVaultError"

  constructor(
    readonly code:
      | "not_found"
      | "conflict"
      | "invalid"
      | "storage_conflict",
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message)
  }
}

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

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

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

  async initialize(): Promise<void> {}

  async load(): Promise<VaultSnapshot> {
    return decodeSnapshot(JSON.parse(snapshotJson(this.snapshot)))
  }

  async commit(
    expectedVersion: number,
    next: VaultSnapshot,
    projection: SearchProjection,
    pages: ReadonlyArray<MemoryPage>
  ): Promise<boolean> {
    if (this.snapshot.version !== expectedVersion) return false
    this.snapshot = decodeSnapshot(JSON.parse(snapshotJson(next)))
    this.indexedRows = projection.rows
    this.projectedPages = new Map(pages.map((page) => [page.id, serializeMemoryMarkdown(page)]))
    this.navigation = {
      indexMarkdown: projection.indexMarkdown,
      logMarkdown: projection.logMarkdown
    }
    return true
  }

  async loadProjectedPages(pageIds?: ReadonlyArray<string>): Promise<ReadonlyArray<MemoryPage>> {
    const ids = pageIds ?? [...this.projectedPages.keys()]
    return ids.flatMap((pageId) => {
      const markdown = this.projectedPages.get(pageId)
      return markdown === undefined ? [] : [parseMemoryMarkdown(markdown)]
    })
  }

  async loadNavigation(): Promise<Pick<SearchProjection, "indexMarkdown" | "logMarkdown"> | undefined> {
    return this.navigation
  }

  async recordRetrieval(metric: RetrievalMetric): Promise<void> {
    this.retrievals.set(metric.id, metric)
  }

  async listRetrievals(): Promise<ReadonlyArray<RetrievalMetric>> {
    return [...this.retrievals.values()]
  }

  async searchPageIds(query: string, limit: number): Promise<ReadonlyArray<string>> {
    const normalized = query.toLocaleLowerCase("en-US")
    return this.indexedRows
      .filter((row) =>
        [row.path, row.title, row.body, row.aliases, row.tags].some((value) =>
          value.toLocaleLowerCase("en-US").includes(normalized)
        )
      )
      .slice(0, limit)
      .map((row) => row.pageId)
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

export class SqliteVaultState implements VaultStateStorage {
  constructor(private readonly sql: SqlStorageLike) {}

  async initialize(): Promise<void> {
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
  }

  async load(): Promise<VaultSnapshot> {
    const row = this.sql
      .exec<StateRow>("SELECT version, state_json FROM vault_state WHERE singleton = 1")
      .toArray()[0]
    if (row === undefined) throw new MemoryVaultError("not_found", "vault state was not initialized", 404)
    let parsed: unknown
    try {
      parsed = JSON.parse(row.state_json)
    } catch (error) {
      throw new MemoryVaultError("invalid", `invalid persisted vault state: ${String(error)}`)
    }
    const snapshot = decodeSnapshot(parsed)
    return snapshot.version === row.version ? snapshot : { ...snapshot, version: row.version }
  }

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

  async commit(
    expectedVersion: number,
    next: VaultSnapshot,
    projection: SearchProjection,
    pages: ReadonlyArray<MemoryPage>
  ): Promise<boolean> {
    this.sql.exec("BEGIN IMMEDIATE")
    try {
      const result = this.sql.exec(
        "UPDATE vault_state SET version = ?, state_json = ? WHERE singleton = 1 AND version = ?",
        next.version,
        snapshotJson(next),
        expectedVersion
      )
      if (result.rowsWritten !== 1) {
        this.sql.exec("ROLLBACK")
        return false
      }
      this.replaceProjection(projection, pages)
      this.sql.exec("COMMIT")
      return true
    } catch (error) {
      this.sql.exec("ROLLBACK")
      throw error
    }
  }

  async loadProjectedPages(pageIds?: ReadonlyArray<string>): Promise<ReadonlyArray<MemoryPage> | undefined> {
    const rows = pageIds === undefined
      ? this.sql.exec<ProjectedPageRow>("SELECT page_markdown FROM memory_pages ORDER BY page_id").toArray()
      : pageIds.flatMap((pageId) =>
          this.sql
            .exec<ProjectedPageRow>("SELECT page_markdown FROM memory_pages WHERE page_id = ?", pageId)
            .toArray()
        )
    if (rows.length === 0) {
      const state = await this.load()
      if (state.heads.length > 0) return undefined
    }
    return rows.map((row) => parseMemoryMarkdown(row.page_markdown))
  }

  async loadNavigation(): Promise<Pick<SearchProjection, "indexMarkdown" | "logMarkdown"> | undefined> {
    const row = this.sql
      .exec<NavigationRow>(
        "SELECT index_markdown, log_markdown FROM memory_navigation WHERE singleton = 1"
      )
      .toArray()[0]
    return row === undefined
      ? undefined
      : { indexMarkdown: row.index_markdown, logMarkdown: row.log_markdown }
  }

  async recordRetrieval(metric: RetrievalMetric): Promise<void> {
    this.sql.exec(
      "INSERT OR IGNORE INTO memory_retrievals(id, occurred_at, query_hash, result_count, duration_ms) VALUES (?, ?, ?, ?, ?)",
      metric.id,
      metric.occurredAt,
      metric.queryHash,
      metric.resultCount,
      metric.durationMs
    )
  }

  async listRetrievals(): Promise<ReadonlyArray<RetrievalMetric>> {
    return this.sql
      .exec<{
        readonly id: string
        readonly occurred_at: string
        readonly query_hash: string
        readonly result_count: number
        readonly duration_ms: number
      }>("SELECT id, occurred_at, query_hash, result_count, duration_ms FROM memory_retrievals ORDER BY occurred_at, id")
      .toArray()
      .map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at,
        queryHash: row.query_hash,
        resultCount: row.result_count,
        durationMs: row.duration_ms
      }))
  }

  async searchPageIds(query: string, limit: number): Promise<ReadonlyArray<string> | undefined> {
    const terms = query
      .normalize("NFKC")
      .split(SEARCH_WHITESPACE_PATTERN)
      .map((term) => term.replace(INVALID_SEARCH_TERM_PATTERN, ""))
      .filter((term) => term.length > 0)
      .map((term) => `"${term.replace(/"/g, '""')}"`)
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
    }
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
    throw new MemoryVaultError("invalid", `head ${head.pageId} has no revision ${head.revisionId}`)
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
  private mutationTail: Promise<void> = Promise.resolve()

  private constructor(
    readonly organizationId: string,
    private readonly state: VaultStateStorage,
    private readonly objects: MemoryR2Store
  ) {}

  static async create(
    organizationId: string,
    state: VaultStateStorage,
    bucket: R2BucketLike
  ): Promise<TeamVault> {
    await state.initialize()
    return new TeamVault(organizationId, state, new MemoryR2Store(organizationId, bucket))
  }

  private async serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.mutationTail
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.mutationTail = previous.then(() => gate)
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async loadPages(
    snapshot: VaultSnapshot,
    pageIds?: ReadonlyArray<string>
  ): Promise<Array<MemoryPage>> {
    const projected = await this.state.loadProjectedPages(pageIds)
    if (projected !== undefined) return [...projected]
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
  }

  private sources(snapshot: VaultSnapshot): ReadonlyArray<MemorySource> {
    return snapshot.sources.map((record) => record.source)
  }

  private async persist(
    current: VaultSnapshot,
    changes: Omit<VaultSnapshot, "version">,
    pages: ReadonlyArray<MemoryPage>
  ): Promise<VaultSnapshot> {
    const next: VaultSnapshot = { ...changes, version: current.version + 1 }
    const projection = buildSearchProjection(pages, acceptedLog(next))
    if (!(await this.state.commit(current.version, next, projection, pages))) {
      throw new MemoryVaultError("storage_conflict", "vault state changed concurrently", 409)
    }
    await this.objects.putHistorySnapshot(next.version, canonicalJson(historyFor(next)))
    return next
  }

  async ingestSource(
    source: MemorySource,
    content: string,
    retrieval: MemoryRetrievalSummaryType = {
      searches: 0,
      reads: 0,
      navigation: 0,
      graphReads: 0,
      proposals: 0
    }
  ): Promise<StoredSourceRecord> {
    return this.serialized(async () => {
      const current = await this.state.load()
      const existing = current.sources.find((record) => record.source.id === source.id)
      const metric: SessionRetrievalMetric = {
        id: `session-retrieval:${source.id}`,
        occurredAt: source.retrievedAt ?? new Date().toISOString(),
        ...retrieval
      }
      if (existing !== undefined) {
        if ((await this.objects.readSourceContent(existing)) === content) {
          if (!current.sessionRetrievals.some((candidate) => candidate.id === metric.id)) {
            await this.persist(
              current,
              {
                ...current,
                sessionRetrievals: boundedSessionRetrievals([
                  ...current.sessionRetrievals,
                  metric
                ])
              },
              await this.loadPages(current)
            )
          }
          return existing
        }
        throw new MemoryVaultError("conflict", `source id ${source.id} already exists`, 409)
      }
      const stored = await this.objects.putSource(source, content)
      const pages = await this.loadPages(current)
      await this.persist(
        current,
        {
          ...current,
          sources: uniqueSourceRecords([...current.sources, stored]),
          sessionRetrievals: boundedSessionRetrievals([...current.sessionRetrievals, metric])
        },
        pages
      )
      return stored
    })
  }

  async ingestAcceptedPage(input: IngestAcceptedPageInput): Promise<AcceptedPageResponse> {
    return this.serialized(async () => {
      const current = await this.state.load()
      const duplicateRevision = current.revisions.find((revision) => revision.id === input.revisionId)
      if (duplicateRevision !== undefined) {
        const head = current.heads.find((candidate) => candidate.revisionId === duplicateRevision.id)
        if (head === undefined) {
          throw new MemoryVaultError("conflict", `revision id ${input.revisionId} already exists`, 409)
        }
        const markdown = await this.objects.readMarkdown(duplicateRevision.markdownKey)
        if (serializeMemoryMarkdown(parseMemoryPage(head.path, markdown)) !== serializeMemoryMarkdown(parseMemoryPage(head.path, input.markdown))) {
          throw new MemoryVaultError("conflict", `revision id ${input.revisionId} already exists`, 409)
        }
        return this.acceptedPageResponse(current, head)
      }
      const candidate = parseMemoryMarkdown(input.markdown)
      if (candidate.revision !== 1) {
        throw new MemoryVaultError("invalid", "an initial accepted page must have revision 1")
      }
      if (current.heads.some((head) => head.pageId === candidate.id)) {
        throw new MemoryVaultError("conflict", `page ${candidate.id} already exists; create a proposal`, 409)
      }
      const existingPages = await this.loadPages(current)
      assertMemoryValid(
        { pages: [...existingPages, candidate], sources: this.sources(current) },
        { requireCitations: true }
      )
      const canonicalMarkdown = serializeMemoryMarkdown(candidate)
      const stored = await this.objects.putAcceptedRevision(canonicalMarkdown, {
        id: input.revisionId,
        pageId: candidate.id,
        revision: 1,
        authorId: input.actorId,
        createdAt: input.createdAt,
        acceptedAt: input.createdAt
      })
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
      const next = await this.persist(
        current,
        {
          ...current,
          heads: [...current.heads, head].sort((left, right) => compareText(left.pageId, right.pageId)),
          revisions: uniqueById([...current.revisions, stored]),
          events
        },
        pages
      )
      return this.acceptedPageResponse(next, head)
    })
  }

  async createProposal(input: CreateProposalInput): Promise<MemoryProposal> {
    return this.serialized(async () => {
      const current = await this.state.load()
      const proposal: MemoryProposal = { ...input, status: "open" }
      const decoded = Schema.decodeUnknownSync(MemoryProposalSchema)(proposal)
      const existing = current.proposals.find((candidate) => candidate.id === input.id)
      if (existing !== undefined) {
        if (canonicalJson(existing) === canonicalJson(decoded)) return existing
        throw new MemoryVaultError("conflict", `proposal id ${input.id} already exists`, 409)
      }
      const head = current.heads.find((candidate) => candidate.pageId === input.pageId)
      if (head === undefined) throw new MemoryVaultError("not_found", `page ${input.pageId} was not found`, 404)
      if (head.revisionId !== input.baseRevisionId) {
        throw new MemoryVaultError(
          "conflict",
          `proposal base ${input.baseRevisionId} is stale; current head is ${head.revisionId}`,
          409
        )
      }
      const parsed = parseMemoryPage(head.path, input.markdown)
      if (parsed.id !== input.pageId || parsed.revision !== head.revision + 1) {
        throw new MemoryVaultError("invalid", "proposal identity or revision number is invalid")
      }
      const pages = await this.loadPages(current)
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
      await this.persist(
        current,
        {
          ...current,
          proposals: uniqueById([...current.proposals, decoded]),
          events: uniqueById([...current.events, event])
        },
        pages
      )
      return decoded
    })
  }

  async createProposalSet(input: CreateProposalSetInput): Promise<VaultProposalSet> {
    return this.serialized(async () => {
      const current = await this.state.load()
      const pages = await this.loadPages(current)
      const prepared = prepareProposalSet(input, pages, current.heads, this.sources(current))
      const existing = current.proposalSets.find((candidate) => candidate.id === input.id)
      if (existing !== undefined) {
        if (proposalSetMatches(existing, current.proposals, prepared)) return existing
        throw new MemoryVaultError("conflict", `proposal set id ${input.id} already exists`, 409)
      }
      if (current.proposals.some((proposal) => prepared.set.proposalIds.includes(proposal.id))) {
        throw new MemoryVaultError("conflict", `proposal ids for set ${input.id} already exist`, 409)
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
      await this.persist(
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
    })
  }

  async approveProposalSet(
    proposalSetId: string,
    reviewerId: string,
    acceptedAt: string
  ): Promise<ProposalSetApprovalResult> {
    return this.serialized(async () => {
      const current = await this.state.load()
      const proposalSet = current.proposalSets.find((candidate) => candidate.id === proposalSetId)
      if (proposalSet === undefined) {
        throw new MemoryVaultError("not_found", `proposal set ${proposalSetId} was not found`, 404)
      }
      const setProposals = proposalSet.proposalIds.map((proposalId) => {
        const proposal = current.proposals.find((candidate) => candidate.id === proposalId)
        if (proposal === undefined) {
          throw new MemoryVaultError("invalid", `proposal set ${proposalSetId} is incomplete`)
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
              throw new MemoryVaultError("invalid", `accepted proposal ${proposal.id} has no revision`)
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
          await this.persist(
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
            await this.loadPages(current)
          )
        }
        return { status: "conflict", proposalSetId, conflicts }
      }

      const pages = await this.loadPages(current)
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
          throw new MemoryVaultError("invalid", `proposal page ${proposal.pageId} disappeared`)
        }
        if (head === undefined && proposal.baseRevisionId !== NEW_PAGE_BASE_REVISION_ID) {
          throw new MemoryVaultError("invalid", `proposal page ${proposal.pageId} lost its accepted head`)
        }
        storedRevisions.push(
          await this.objects.putAcceptedRevision(serializeMemoryMarkdown(candidate), {
            id: `revision:${proposal.id}`,
            pageId: proposal.pageId,
            revision: candidate.revision,
            ...(head === undefined ? {} : { parentRevisionId: head.revisionId }),
            authorId: proposal.proposedBy,
            createdAt: proposal.createdAt,
            acceptedAt,
            publicationId: proposalSet.id
          })
        )
      }
      await this.objects.putPublicationCommit({
        id: proposalSet.id,
        revisionIds: storedRevisions.map((revision) => revision.id),
        acceptedAt
      })

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
      await this.persist(
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
    })
  }

  async rejectProposalSet(
    proposalSetId: string,
    reviewerId: string,
    rejectedAt: string
  ): Promise<VaultProposalSet> {
    return this.serialized(async () => {
      const current = await this.state.load()
      const proposalSet = current.proposalSets.find((candidate) => candidate.id === proposalSetId)
      if (proposalSet === undefined) {
        throw new MemoryVaultError("not_found", `proposal set ${proposalSetId} was not found`, 404)
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
      await this.persist(
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
        await this.loadPages(current)
      )
      return rejected
    })
  }

  async approveProposal(proposalId: string, reviewerId: string, acceptedAt: string): Promise<ApprovalResult> {
    return this.serialized(async () => {
      const current = await this.state.load()
      const proposal = current.proposals.find((candidate) => candidate.id === proposalId)
      if (proposal === undefined) throw new MemoryVaultError("not_found", `proposal ${proposalId} was not found`, 404)
      const head = current.heads.find((candidate) => candidate.pageId === proposal.pageId)
      if (head === undefined) throw new MemoryVaultError("not_found", `page ${proposal.pageId} was not found`, 404)
      if (proposal.status === "accepted") {
        const revision = current.revisions.find((candidate) => candidate.id === `revision:${proposal.id}`)
        if (revision === undefined) throw new MemoryVaultError("invalid", "accepted proposal revision is missing")
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
          await this.persist(current, { ...current, proposals }, await this.loadPages(current))
        }
        return {
          status: "conflict",
          proposalId,
          pageId: proposal.pageId,
          expectedBaseRevisionId: proposal.baseRevisionId,
          currentHeadRevisionId: head.revisionId
        }
      }
      const pages = await this.loadPages(current)
      const candidate = parseMemoryPage(head.path, proposal.markdown)
      if (candidate.id !== proposal.pageId || candidate.revision !== head.revision + 1) {
        throw new MemoryVaultError("invalid", "proposal identity or revision number is invalid")
      }
      const acceptedPages = pages.map((page) => (page.id === candidate.id ? candidate : page))
      assertMemoryValid(
        { pages: acceptedPages, sources: this.sources(current) },
        { requireCitations: true }
      )
      const revisionId = `revision:${proposal.id}`
      const stored = await this.objects.putAcceptedRevision(serializeMemoryMarkdown(candidate), {
        id: revisionId,
        pageId: candidate.id,
        revision: candidate.revision,
        parentRevisionId: head.revisionId,
        authorId: proposal.proposedBy,
        createdAt: proposal.createdAt,
        acceptedAt
      })
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
      await this.persist(
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
    })
  }

  async rejectProposal(proposalId: string, reviewerId: string, rejectedAt: string): Promise<MemoryProposal> {
    return this.serialized(async () => {
      const current = await this.state.load()
      const proposal = current.proposals.find((candidate) => candidate.id === proposalId)
      if (proposal === undefined) throw new MemoryVaultError("not_found", `proposal ${proposalId} was not found`, 404)
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
      await this.persist(
        current,
        {
          ...current,
          proposals: current.proposals.map((candidate) =>
            candidate.id === proposal.id ? rejected : candidate
          ),
          events: uniqueById([...current.events, event])
        },
        await this.loadPages(current)
      )
      return rejected
    })
  }

  private async acceptedPageResponse(
    snapshot: VaultSnapshot,
    head: VaultPageHead
  ): Promise<AcceptedPageResponse> {
    const revision = revisionForHead(snapshot, head)
    const page = parseMemoryPage(head.path, await this.objects.readMarkdown(head.markdownKey))
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
  }

  async readPage(pageId: string): Promise<AcceptedPageResponse> {
    const snapshot = await this.state.load()
    const head = snapshot.heads.find((candidate) => candidate.pageId === pageId)
    if (head === undefined) throw new MemoryVaultError("not_found", `page ${pageId} was not found`, 404)
    return this.acceptedPageResponse(snapshot, head)
  }

  async listPages(): Promise<ReadonlyArray<VaultPageHead>> {
    return [...(await this.state.load()).heads].sort((left, right) => compareText(left.path, right.path))
  }

  async listSources(): Promise<ReadonlyArray<MemorySource>> {
    return [...this.sources(await this.state.load())].sort((left, right) => compareText(left.id, right.id))
  }

  async readSource(sourceId: string): Promise<StoredSourceResponse> {
    const record = (await this.state.load()).sources.find((candidate) => candidate.source.id === sourceId)
    if (record === undefined) {
      throw new MemoryVaultError("not_found", `source ${sourceId} was not found`, 404)
    }
    return {
      source: record.source,
      contentHash: record.contentHash,
      content: await this.objects.readSourceContent(record)
    }
  }

  async getProposal(proposalId: string): Promise<MemoryProposal> {
    const proposal = (await this.state.load()).proposals.find((candidate) => candidate.id === proposalId)
    if (proposal === undefined) throw new MemoryVaultError("not_found", `proposal ${proposalId} was not found`, 404)
    return proposal
  }

  async getProposalSet(proposalSetId: string): Promise<VaultProposalSet> {
    const proposalSet = (await this.state.load()).proposalSets.find(
      (candidate) => candidate.id === proposalSetId
    )
    if (proposalSet === undefined) {
      throw new MemoryVaultError("not_found", `proposal set ${proposalSetId} was not found`, 404)
    }
    return proposalSet
  }

  async listProposalSets(limit = 50): Promise<ReadonlyArray<VaultProposalSet & {
    readonly pages: ReadonlyArray<MemoryProposal>
  }>> {
    const snapshot = await this.state.load()
    return [...snapshot.proposalSets]
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
  }

  async search(query: string, limit = 20, occurredAt = new Date().toISOString()): Promise<VaultSearchResponse> {
    const startedAt = performance.now()
    const snapshot = await this.state.load()
    const candidatePageIds = await this.state.searchPageIds(query, Math.max(limit * 4, 100))
    const pages = await this.loadPages(snapshot, candidatePageIds)
    const response = searchAcceptedPages(pages, query, limit)
    const metric: RetrievalMetric = {
      id: `retrieval:${crypto.randomUUID()}`,
      occurredAt,
      queryHash: await sha256ContentHash(query.normalize("NFKC").toLocaleLowerCase("en-US")),
      resultCount: response.results.length,
      durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000)
    }
    await this.objects.putRetrievalMetric(metric.id, canonicalJson(metric))
    await this.state.recordRetrieval(metric)
    return response
  }

  async navigation(): Promise<Pick<SearchProjection, "indexMarkdown" | "logMarkdown">> {
    const stored = await this.state.loadNavigation()
    if (stored !== undefined) return stored
    const snapshot = await this.state.load()
    const projection = buildSearchProjection(await this.loadPages(snapshot), acceptedLog(snapshot))
    return { indexMarkdown: projection.indexMarkdown, logMarkdown: projection.logMarkdown }
  }

  async compilerContext(claims: ReadonlyArray<string>): Promise<CompilerVaultContext> {
    const snapshot = await this.state.load()
    const candidateIds = new Set<string>()
    for (const claim of claims.slice(0, 32)) {
      for (const pageId of (await this.state.searchPageIds(claim, 12)) ?? []) {
        candidateIds.add(pageId)
        if (candidateIds.size >= 48) break
      }
      if (candidateIds.size >= 48) break
    }
    const candidatePages = await this.loadPages(snapshot, [...candidateIds])
    const projectedPages = (await this.state.loadProjectedPages()) ?? []
    const schemaPages = projectedPages
      .filter((page) =>
        page.tags.includes("schema") || page.metadata.kind === "schema" || page.metadata.schema === true
      )
      .slice(0, 8)
    const heads = new Map(snapshot.heads.map((head) => [head.pageId, head]))
    const navigation = await this.navigation()
    return {
      candidates: candidatePages.flatMap((page) => {
        const head = heads.get(page.id)
        return head === undefined ? [] : [{ page, revisionId: head.revisionId }]
      }),
      schemaPages,
      indexMarkdown: navigation.indexMarkdown.slice(0, 32_000)
    }
  }

  async exportVault(): Promise<VaultExport> {
    const snapshot = await this.state.load()
    const heads = [...snapshot.heads].sort((left, right) => compareText(left.path, right.path))
    const pages = await this.loadPages(snapshot)
    const navigation = buildSearchProjection(pages, acceptedLog(snapshot))
    const pageFiles = await Promise.all(
      heads.map(async (head) => ({
        path: head.path,
        content: await this.objects.readMarkdown(head.markdownKey)
      }))
    )
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
  }

  async graph(
    options: { readonly limit?: number; readonly cursor?: number },
    asOf?: string
  ): Promise<VaultGraphView> {
    const snapshot = await this.state.load()
    const pages = await this.loadPages(snapshot)
    return buildBoundedGraphView(pages, this.sources(snapshot), options, {
      acceptedAtByPageId: new Map(snapshot.heads.map((head) => [head.pageId, head.acceptedAt])),
      ...(asOf === undefined ? {} : { now: asOf })
    })
  }

  async neighborhood(nodeId: string, limit?: number, asOf?: string): Promise<VaultGraphView> {
    const snapshot = await this.state.load()
    return buildGraphNeighborhood(
      await this.loadPages(snapshot),
      this.sources(snapshot),
      nodeId,
      limit,
      {
        acceptedAtByPageId: new Map(snapshot.heads.map((head) => [head.pageId, head.acceptedAt])),
        ...(asOf === undefined ? {} : { now: asOf })
      }
    )
  }

  async edgeEvidence(edgeId: string): Promise<VaultGraphEvidenceResponse> {
    const snapshot = await this.state.load()
    const evidence = findGraphEdgeEvidence(
      await this.loadPages(snapshot),
      this.sources(snapshot),
      edgeId
    )
    if (evidence === undefined) throw new MemoryVaultError("not_found", `edge ${edgeId} was not found`, 404)
    return evidence
  }

  async dashboard(asOf: string): Promise<VaultDashboardSummary> {
    const snapshot = await this.state.load()
    const retrievals = uniqueById([...snapshot.retrievals, ...(await this.state.listRetrievals())])
    return buildVaultDashboardSummary(
      {
        pages: await this.loadPages(snapshot),
        sourceCount: snapshot.sources.length,
        revisions: snapshot.revisions,
        proposals: snapshot.proposals,
        events: snapshot.events,
        heads: snapshot.heads,
        retrievals,
        sessionRetrievals: snapshot.sessionRetrievals
      },
      asOf
    )
  }

  async rebuildFromR2(): Promise<RebuildResult> {
    return this.serialized(async () => {
      const current = await this.state.load()
      const publicationRecords = await this.objects.listPublicationRecords()
      const storedRevisions = await this.objects.listRevisionRecords()
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
      const sources = uniqueSourceRecords(await this.objects.listSourceRecords())
      const history = decodeHistory(await this.objects.readLatestHistorySnapshot())
      const retrievals = uniqueById([
        ...history.retrievals,
        ...(await Promise.all(
          (await this.objects.listRetrievalMetrics()).map(async (value) =>
            Schema.decodeUnknownSync(RetrievalMetricSchema)(JSON.parse(value))
          )
        ))
      ])
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
      const pages = await Promise.all(
        [...latestByPage.values()]
          .sort((left, right) => compareText(left.pageId, right.pageId))
          .map(async (revision) => parseMemoryMarkdown(await this.objects.readMarkdown(revision.markdownKey)))
      )
      assertMemoryValid({ pages, sources: sources.map((record) => record.source) })
      const pageById = new Map(pages.map((page) => [page.id, page]))
      const heads = [...latestByPage.values()]
        .map((revision): VaultPageHead => {
          const page = pageById.get(revision.pageId)
          if (page === undefined) throw new MemoryVaultError("invalid", `rebuilt page ${revision.pageId} is missing`)
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
      await this.persist(
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
    })
  }

  /** Test/support hook for verifying deterministic aggregate inputs without exposing it over HTTP. */
  async snapshot(): Promise<VaultSnapshot> {
    return this.state.load()
  }
}
