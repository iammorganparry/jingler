import { Effect } from "effect"
import { serializeMemoryMarkdown, type MemoryPage, type MemorySource } from "@jingler/memory"
import { describe, expect, it, vi } from "vitest"
import type { DurableObjectStorageLike, SqlStorageCursor, SqlStorageLike } from "./env.js"
import { HISTORY_SNAPSHOT_INTERVAL, InMemoryR2Bucket, MemoryR2Store } from "./r2-store.js"
import { buildSearchProjection, searchAcceptedPages } from "./search.js"
import {
  InMemoryVaultState,
  RETRIEVAL_RETENTION,
  SqliteVaultState,
  TeamVault
} from "./team-vault.js"

// Runs an Effect-returning vault/layer/state method to a Promise at the test boundary.
const run = Effect.runPromise


const source: MemorySource = {
  id: "source-1",
  kind: "manual",
  title: "Runbook evidence"
}

const page = (revision: number, body: string): MemoryPage => ({
  id: "runbook",
  path: "runbook.md",
  title: "Runbook",
  revision,
  aliases: ["Operations runbook"],
  tags: ["operations"],
  sources: [],
  citations: [{ id: "runbook-citation", sourceId: source.id }],
  relationships: [],
  body,
  metadata: {}
})

class EmptySqlCursor<Row> implements SqlStorageCursor<Row> {
  constructor(readonly rowsWritten = 0) {}
  private readonly rows: Array<Row> = [];

  [Symbol.iterator](): Iterator<Row> {
    return this.rows[Symbol.iterator]()
  }

  toArray(): Array<Row> {
    return [...this.rows]
  }
}

// A storage double that records every `exec` query and every `transactionSync`
// bracket, so tests can prove the commit path brackets its writes in a transaction
// and never emits a raw BEGIN/COMMIT/ROLLBACK (which real DO SQLite rejects).
class RecordingSqlStorage implements SqlStorageLike, DurableObjectStorageLike {
  readonly queries: Array<string> = []
  /** Every exec's positional bindings, parallel to {@link queries}. */
  readonly bindings: Array<ReadonlyArray<string | number | null>> = []
  transactionSyncCalls = 0
  /** Override to make a specific query fail mid-transaction. */
  failOn?: (query: string) => boolean
  /** Override rowsWritten for `UPDATE vault_state` to exercise the stale path. */
  updateRowsWritten = 1

  get sql(): SqlStorageLike {
    return this
  }

  transactionSync<Result>(closure: () => Result): Result {
    this.transactionSyncCalls += 1
    return closure()
  }

  exec<Row = Record<string, unknown>>(
    query: string,
    ...bindings: ReadonlyArray<string | number | null>
  ): SqlStorageCursor<Row> {
    this.queries.push(query)
    this.bindings.push(bindings)
    if (this.failOn?.(query)) throw new Error(`exec failed: ${query}`)
    return new EmptySqlCursor<Row>(
      query.startsWith("UPDATE vault_state") ? this.updateRowsWritten : 0
    )
  }
}

const RAW_TRANSACTION_STATEMENTS = ["BEGIN", "COMMIT", "ROLLBACK"] as const

const projectedCommit = (sql: RecordingSqlStorage) => {
  const state = new SqliteVaultState(sql)
  const projectedPage = page(1, "# Runbook\n\nLexical content. [@runbook-citation]\n")
  return {
    state,
    commit: state.commit(
      0,
      {
        version: 1,
        heads: [],
        revisions: [],
        sources: [],
        proposals: [],
        proposalSets: [],
        events: [],
        retrievals: [],
        sessionRetrievals: []
      },
      buildSearchProjection([projectedPage], []),
      [projectedPage]
    )
  }
}

describe("TeamVault", () => {
  it("accepts exactly one concurrent proposal and reports the other as a conflict", async () => {
    const bucket = new InMemoryR2Bucket()
    const vault = await run(TeamVault.create("org-one", new InMemoryVaultState(), bucket))
    await run(vault.ingestSource(source, "Primary runbook evidence"))
    const initial = serializeMemoryMarkdown(page(1, "# Runbook\n\nThe initial procedure is valid. [@runbook-citation]\n"))
    const first = await run(vault.ingestAcceptedPage({
      revisionId: "revision-1",
      markdown: initial,
      actorId: "author-1",
      createdAt: "2026-07-01T00:00:00.000Z"
    }))
    expect(first.revision.id).toBe("revision-1")

    await Promise.all([
      run(vault.createProposal({
        id: "proposal-a",
        pageId: "runbook",
        baseRevisionId: "revision-1",
        markdown: serializeMemoryMarkdown(
          page(2, "# Runbook\n\nThe accepted procedure uses path A. [@runbook-citation]\n")
        ),
        proposedBy: "author-a",
        createdAt: "2026-07-02T00:00:00.000Z"
      })),
      run(vault.createProposal({
        id: "proposal-b",
        pageId: "runbook",
        baseRevisionId: "revision-1",
        markdown: serializeMemoryMarkdown(
          page(2, "# Runbook\n\nThe competing procedure uses path B. [@runbook-citation]\n")
        ),
        proposedBy: "author-b",
        createdAt: "2026-07-02T00:00:01.000Z"
      }))
    ])

    const outcomes = await Promise.all([
      run(vault.approveProposal("proposal-a", "reviewer", "2026-07-03T00:00:00.000Z")),
      run(vault.approveProposal("proposal-b", "reviewer", "2026-07-03T00:00:01.000Z"))
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["accepted", "conflict"])
    expect((await run(vault.readPage("runbook"))).page.revision).toBe(2)
    expect((await run(vault.getProposal("proposal-b"))).status).toBe("superseded")
    expect((await run(vault.snapshot())).revisions).toHaveLength(2)
  })

  it("is idempotent and rebuilds accepted heads and lexical search entirely from R2", async () => {
    const bucket = new InMemoryR2Bucket()
    const original = await run(TeamVault.create("org-rebuild", new InMemoryVaultState(), bucket))
    await run(original.ingestSource(source, "Primary runbook evidence"))
    const markdown = serializeMemoryMarkdown(
      page(1, "# Runbook\n\nThe albatross procedure is valid. [@runbook-citation]\n")
    )
    const input = {
      revisionId: "revision-rebuild",
      markdown,
      actorId: "author",
      createdAt: "2026-07-01T00:00:00.000Z"
    }
    await run(original.ingestAcceptedPage(input))
    await run(original.ingestAcceptedPage(input))
    expect((await run(original.snapshot())).revisions).toHaveLength(1)

    const rebuilt = await run(TeamVault.create("org-rebuild", new InMemoryVaultState(), bucket))
    expect(await run(rebuilt.rebuildFromR2())).toEqual({ pages: 1, revisions: 1, sources: 1 })
    expect((await run(rebuilt.readPage("runbook"))).revision.id).toBe("revision-rebuild")
    expect((await run(rebuilt.search("albatross", 10, "2026-08-01T00:00:00.000Z"))).results[0]).toMatchObject({
      pageId: "runbook",
      revision: 1,
      citationIds: ["runbook-citation"]
    })
  })

  it("rejects every revision from an incomplete multi-page publication during rebuild", async () => {
    const bucket = new InMemoryR2Bucket()
    const objects = new MemoryR2Store("org-partial", bucket)
    for (const pageId of ["alpha", "beta"]) {
      await objects.putAcceptedRevision(
        serializeMemoryMarkdown({
          ...page(1, `# ${pageId}\n\nAccepted content.\n`),
          id: pageId,
          path: `${pageId}.md`,
          title: pageId,
          aliases: [],
          tags: [],
          citations: [],
          metadata: { citationPolicy: "none" }
        }),
        {
          id: `revision-${pageId}`,
          pageId,
          revision: 1,
          authorId: "author",
          createdAt: "2026-08-01T00:00:00.000Z",
          acceptedAt: "2026-08-01T00:00:00.000Z",
          publicationId: "publication-partial"
        }
      )
    }
    await objects.putPublicationCommit({
      id: "publication-partial",
      revisionIds: ["revision-alpha", "revision-beta"],
      acceptedAt: "2026-08-01T00:00:00.000Z"
    })
    let deletedRevision = false
    for (const key of bucket.keys().filter((candidate) => candidate.includes("/revisions/"))) {
      const value = await bucket.get(key)
      if ((await value?.text())?.includes("revision-beta")) {
        bucket.deleteForTest(key)
        deletedRevision = true
      }
    }
    expect(deletedRevision).toBe(true)
    const rebuilt = await run(TeamVault.create("org-partial", new InMemoryVaultState(), bucket))
    expect(await run(rebuilt.rebuildFromR2())).toEqual({ pages: 0, revisions: 0, sources: 0 })
    expect(await run(rebuilt.listPages())).toEqual([])
  })

  it("retrieves index entries, wikilinks, and backlinks without embeddings", () => {
    const target: MemoryPage = {
      ...page(1, "# Target\n"),
      id: "target",
      path: "target.md",
      title: "Target",
      citations: [],
      metadata: { citationPolicy: "none" }
    }
    const linking: MemoryPage = {
      ...page(1, "# Linking page\n\nNavigate to [[Target]].\n"),
      id: "linking",
      path: "linking.md",
      title: "Linking page",
      citations: [],
      metadata: { citationPolicy: "none" }
    }
    const pages = [linking, target]
    const targetSearch = searchAcceptedPages(pages, "Target")
    expect(targetSearch.results.find((result) => result.pageId === "target")?.matchKinds).toContain(
      "index"
    )
    expect(targetSearch.results.find((result) => result.pageId === "linking")?.matchKinds).toContain(
      "wikilink"
    )
    expect(
      searchAcceptedPages(pages, "Linking page").results.find((result) => result.pageId === "target")
        ?.matchKinds
    ).toContain("backlink")
    const navigation = buildSearchProjection(pages, [])
    expect(navigation.indexMarkdown).toContain("[[target|Target]] — backlinks: linking")
  })

  it("exports accepted Markdown verbatim in an Obsidian vault layout", async () => {
    const vault = await run(TeamVault.create("org-export", new InMemoryVaultState(), new InMemoryR2Bucket()))
    const markdown = serializeMemoryMarkdown({
      ...page(1, "# Runbook\n\nContinue with [[Runbook]].\n"),
      citations: [],
      metadata: { citationPolicy: "none" }
    })
    await run(vault.ingestAcceptedPage({
      revisionId: "revision-export",
      markdown,
      actorId: "author",
      createdAt: "2026-07-01T00:00:00.000Z"
    }))

    const exported = await run(vault.exportVault())
    expect(exported.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      ".obsidian/app.json",
      "_jingler/manifest.json",
      "_jingler/Index.md",
      "runbook.md"
    ]))
    expect(exported.files.find((file) => file.path === "runbook.md")?.content).toBe(markdown)
    expect(exported.files.find((file) => file.path === "runbook.md")?.content).toContain(
      "[[Runbook]]"
    )
  })

  it("maintains and queries a rebuildable SQLite FTS5 projection", async () => {
    const sql = new RecordingSqlStorage()
    const state = new SqliteVaultState(sql)
    await run(state.initialize())
    const projectedPage = page(1, "# Runbook\n\nLexical content. [@runbook-citation]\n")
    await run(state.commit(
      0,
      {
        version: 1,
        heads: [],
        revisions: [],
        sources: [],
        proposals: [],
        proposalSets: [],
        events: [],
        retrievals: [],
        sessionRetrievals: []
      },
      buildSearchProjection([projectedPage], []),
      [projectedPage]
    ))
    await run(state.searchPageIds("lexical content", 10))
    expect(sql.queries.some((query) => query.includes("USING fts5"))).toBe(true)
    expect(sql.queries.some((query) => query.includes("INSERT INTO memory_fts"))).toBe(true)
    expect(sql.queries.some((query) => query.includes("memory_fts MATCH"))).toBe(true)
    // The commit must bracket its writes in transactionSync and never emit a raw
    // BEGIN/COMMIT/ROLLBACK — Durable-Object SQLite rejects those at runtime.
    expect(sql.transactionSyncCalls).toBe(1)
    expect(
      sql.queries.some((query) =>
        RAW_TRANSACTION_STATEMENTS.some((statement) => query.startsWith(statement))
      )
    ).toBe(false)
  })

  it("rolls back and returns false on a stale version without emitting projection writes", async () => {
    const sql = new RecordingSqlStorage()
    await run(new SqliteVaultState(sql).initialize())
    sql.updateRowsWritten = 0 // optimistic-lock miss
    sql.queries.length = 0
    const { commit } = projectedCommit(sql)
    expect(await run(commit)).toBe(false)
    // The stale marker throws before replaceProjection runs, so the transaction
    // rolls back: no projection writes escaped, and no raw COMMIT was emitted.
    expect(sql.transactionSyncCalls).toBe(1)
    expect(sql.queries.some((query) => query.startsWith("UPDATE vault_state"))).toBe(true)
    expect(sql.queries.some((query) => query.includes("DELETE FROM memory_fts"))).toBe(false)
    expect(sql.queries.some((query) => query.includes("INSERT INTO memory_fts"))).toBe(false)
  })

  it("rolls back and propagates when a write throws mid-commit", async () => {
    const sql = new RecordingSqlStorage()
    await run(new SqliteVaultState(sql).initialize())
    sql.failOn = (query) => query.includes("DELETE FROM memory_fts")
    const { commit } = projectedCommit(sql)
    await expect(run(commit)).rejects.toThrow("exec failed")
    expect(sql.transactionSyncCalls).toBe(1)
  })

  it("bounds history persistence: a mutable latest pointer plus checkpoints only every N versions", async () => {
    const bucket = new InMemoryR2Bucket()
    const store = new MemoryR2Store("org-history", bucket)
    const versions = HISTORY_SNAPSHOT_INTERVAL * 2 + 3
    for (let version = 1; version <= versions; version += 1) {
      await store.putHistory(version, JSON.stringify({ version }))
    }
    // Immutable checkpoints are written only every HISTORY_SNAPSHOT_INTERVAL versions
    // — NOT one new immutable object per version (the old O(N) behaviour).
    const snapshotKeys = bucket.keys().filter((key) => key.includes("history/snapshots/"))
    expect(snapshotKeys).toHaveLength(Math.floor(versions / HISTORY_SNAPSHOT_INTERVAL))
    expect(snapshotKeys.length).toBeLessThan(versions)
    // Exactly one mutable latest pointer, overwritten each version.
    expect(bucket.keys().filter((key) => key.endsWith("history/latest.json"))).toHaveLength(1)
    // The latest read is bounded: a single GET of the pointer, never a full list.
    const listSpy = vi.spyOn(bucket, "list")
    const latest = await store.readLatestHistorySnapshot()
    expect(listSpy).not.toHaveBeenCalled()
    expect(JSON.parse(latest ?? "{}")).toEqual({ version: versions })
    listSpy.mockRestore()
  })

  it("issues FTS5 prefix terms so partial-word queries match the DO like the substring scorer", async () => {
    const sql = new RecordingSqlStorage()
    const state = new SqliteVaultState(sql)
    await run(state.initialize())
    sql.queries.length = 0
    sql.bindings.length = 0
    await run(state.searchPageIds("ret logic", 25))
    const matchIndex = sql.queries.findIndex((query) => query.includes("memory_fts MATCH ?"))
    expect(matchIndex).toBeGreaterThanOrEqual(0)
    // Each token carries a trailing `*` — the FTS5 prefix form — so 'ret' matches the
    // token 'retry' rather than requiring an exact-token match ('"ret"' would not).
    expect(sql.bindings[matchIndex]?.[0]).toBe('"ret"* AND "logic"*')
  })

  it("bounds in-memory retrieval metrics to the newest RETRIEVAL_RETENTION rows", async () => {
    const state = new InMemoryVaultState()
    const total = RETRIEVAL_RETENTION + 250
    for (let index = 0; index < total; index += 1) {
      await run(state.recordRetrieval({
        id: `retrieval:${String(index).padStart(6, "0")}`,
        occurredAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        queryHash: `hash-${index}`,
        resultCount: 0,
        durationMs: 0
      }))
    }
    const kept = await run(state.listRetrievals())
    // The cap holds: N+ records leave exactly N retained, keeping the newest and
    // dropping the oldest.
    expect(kept).toHaveLength(RETRIEVAL_RETENTION)
    expect(kept.some((metric) => metric.id === `retrieval:${String(total - 1).padStart(6, "0")}`)).toBe(
      true
    )
    expect(kept.some((metric) => metric.id === "retrieval:000000")).toBe(false)
  })

  it("prunes the SQLite retrieval table on insert and reads it back bounded", async () => {
    const sql = new RecordingSqlStorage()
    const state = new SqliteVaultState(sql)
    await run(state.recordRetrieval({
      id: "retrieval:1",
      occurredAt: "2026-08-02T00:00:00.000Z",
      queryHash: "hash-1",
      resultCount: 0,
      durationMs: 0
    }))
    // Every insert is followed by a bounded DELETE keeping only the newest rows.
    expect(sql.queries.some((query) => query.startsWith("INSERT OR IGNORE INTO memory_retrievals"))).toBe(
      true
    )
    expect(
      sql.queries.some(
        (query) =>
          query.startsWith("DELETE FROM memory_retrievals") &&
          query.includes("ORDER BY occurred_at DESC, id DESC LIMIT ?")
      )
    ).toBe(true)
    sql.queries.length = 0
    await run(state.listRetrievals())
    // The read is itself capped with an explicit LIMIT.
    expect(
      sql.queries.some((query) => query.includes("FROM memory_retrievals ORDER BY occurred_at, id LIMIT ?"))
    ).toBe(true)
  })

  it("aggregates retrieval metrics into one bounded R2 object per UTC day", async () => {
    const bucket = new InMemoryR2Bucket()
    const vault = await run(TeamVault.create("org-retrieval", new InMemoryVaultState(), bucket))
    await run(vault.ingestSource(source, "Primary runbook evidence"))
    await run(vault.ingestAcceptedPage({
      revisionId: "revision-1",
      markdown: serializeMemoryMarkdown(
        page(1, "# Runbook\n\nThe albatross procedure is valid. [@runbook-citation]\n")
      ),
      actorId: "author",
      createdAt: "2026-07-01T00:00:00.000Z"
    }))

    for (let index = 0; index < 5; index += 1) {
      await run(vault.search("albatross", 10, `2026-08-02T00:00:0${index}.000Z`))
    }
    await run(vault.search("albatross", 10, "2026-08-03T00:00:00.000Z"))

    const retrievalKeys = bucket.keys().filter((key) => key.includes("/history/retrievals/"))
    // One rollup object per UTC day — NOT one immutable object per search.
    expect(retrievalKeys).toHaveLength(2)
    expect(retrievalKeys.some((key) => key.endsWith("2026-08-02.json"))).toBe(true)
    expect(retrievalKeys.some((key) => key.endsWith("2026-08-03.json"))).toBe(true)
    const dayObject = await bucket.get(
      retrievalKeys.find((key) => key.endsWith("2026-08-02.json")) ?? ""
    )
    expect(JSON.parse((await dayObject?.text()) ?? "[]")).toHaveLength(5)
  })

  it("folds only a bounded retrieval set into the dashboard", async () => {
    const state = new InMemoryVaultState()
    const total = RETRIEVAL_RETENTION + 500
    for (let index = 0; index < total; index += 1) {
      await run(state.recordRetrieval({
        id: `retrieval:${String(index).padStart(6, "0")}`,
        occurredAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        queryHash: `hash-${index}`,
        resultCount: 1,
        durationMs: 1
      }))
    }
    const vault = await run(TeamVault.create("org-dashboard", state, new InMemoryR2Bucket()))
    const dashboard = await run(vault.dashboard("2030-01-01T00:00:00.000Z", "all"))
    // `retrieval.searches` counts the folded retrievals; the fold reads the bounded
    // table, so it never exceeds the retention cap no matter how many searches ran.
    expect(dashboard.retrieval.searches).toBe(RETRIEVAL_RETENTION)
  })
})
