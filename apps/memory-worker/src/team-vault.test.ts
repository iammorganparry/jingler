import { serializeMemoryMarkdown, type MemoryPage, type MemorySource } from "@jingler/memory"
import { describe, expect, it } from "vitest"
import type { SqlStorageCursor, SqlStorageLike } from "./env.js"
import { InMemoryR2Bucket } from "./r2-store.js"
import { buildSearchProjection, searchAcceptedPages } from "./search.js"
import { InMemoryVaultState, SqliteVaultState, TeamVault } from "./team-vault.js"

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
  readonly rowsWritten = 0
  private readonly rows: Array<Row> = [];

  [Symbol.iterator](): Iterator<Row> {
    return this.rows[Symbol.iterator]()
  }

  toArray(): Array<Row> {
    return [...this.rows]
  }
}

class RecordingSqlStorage implements SqlStorageLike {
  readonly queries: Array<string> = []

  exec<Row = Record<string, unknown>>(
    query: string,
    ..._bindings: ReadonlyArray<string | number | null>
  ): SqlStorageCursor<Row> {
    this.queries.push(query)
    return new EmptySqlCursor<Row>()
  }
}

describe("TeamVault", () => {
  it("accepts exactly one concurrent proposal and reports the other as a conflict", async () => {
    const bucket = new InMemoryR2Bucket()
    const vault = await TeamVault.create("org-one", new InMemoryVaultState(), bucket)
    await vault.ingestSource(source, "Primary runbook evidence")
    const initial = serializeMemoryMarkdown(page(1, "# Runbook\n\nThe initial procedure is valid. [@runbook-citation]\n"))
    const first = await vault.ingestAcceptedPage({
      revisionId: "revision-1",
      markdown: initial,
      actorId: "author-1",
      createdAt: "2026-07-01T00:00:00.000Z"
    })
    expect(first.revision.id).toBe("revision-1")

    await Promise.all([
      vault.createProposal({
        id: "proposal-a",
        pageId: "runbook",
        baseRevisionId: "revision-1",
        markdown: serializeMemoryMarkdown(
          page(2, "# Runbook\n\nThe accepted procedure uses path A. [@runbook-citation]\n")
        ),
        proposedBy: "author-a",
        createdAt: "2026-07-02T00:00:00.000Z"
      }),
      vault.createProposal({
        id: "proposal-b",
        pageId: "runbook",
        baseRevisionId: "revision-1",
        markdown: serializeMemoryMarkdown(
          page(2, "# Runbook\n\nThe competing procedure uses path B. [@runbook-citation]\n")
        ),
        proposedBy: "author-b",
        createdAt: "2026-07-02T00:00:01.000Z"
      })
    ])

    const outcomes = await Promise.all([
      vault.approveProposal("proposal-a", "reviewer", "2026-07-03T00:00:00.000Z"),
      vault.approveProposal("proposal-b", "reviewer", "2026-07-03T00:00:01.000Z")
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["accepted", "conflict"])
    expect((await vault.readPage("runbook")).page.revision).toBe(2)
    expect((await vault.getProposal("proposal-b")).status).toBe("superseded")
    expect((await vault.snapshot()).revisions).toHaveLength(2)
  })

  it("is idempotent and rebuilds accepted heads and lexical search entirely from R2", async () => {
    const bucket = new InMemoryR2Bucket()
    const original = await TeamVault.create("org-rebuild", new InMemoryVaultState(), bucket)
    await original.ingestSource(source, "Primary runbook evidence")
    const markdown = serializeMemoryMarkdown(
      page(1, "# Runbook\n\nThe albatross procedure is valid. [@runbook-citation]\n")
    )
    const input = {
      revisionId: "revision-rebuild",
      markdown,
      actorId: "author",
      createdAt: "2026-07-01T00:00:00.000Z"
    }
    await original.ingestAcceptedPage(input)
    await original.ingestAcceptedPage(input)
    expect((await original.snapshot()).revisions).toHaveLength(1)

    const rebuilt = await TeamVault.create("org-rebuild", new InMemoryVaultState(), bucket)
    expect(await rebuilt.rebuildFromR2()).toEqual({ pages: 1, revisions: 1, sources: 1 })
    expect((await rebuilt.readPage("runbook")).revision.id).toBe("revision-rebuild")
    expect((await rebuilt.search("albatross", 10, "2026-08-01T00:00:00.000Z")).results[0]).toMatchObject({
      pageId: "runbook",
      revision: 1,
      citationIds: ["runbook-citation"]
    })
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
    const vault = await TeamVault.create("org-export", new InMemoryVaultState(), new InMemoryR2Bucket())
    const markdown = serializeMemoryMarkdown({
      ...page(1, "# Runbook\n\nContinue with [[Runbook]].\n"),
      citations: [],
      metadata: { citationPolicy: "none" }
    })
    await vault.ingestAcceptedPage({
      revisionId: "revision-export",
      markdown,
      actorId: "author",
      createdAt: "2026-07-01T00:00:00.000Z"
    })

    const exported = await vault.exportVault()
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
    await state.initialize()
    await state.replaceSearchProjection(
      buildSearchProjection([page(1, "# Runbook\n\nLexical content. [@runbook-citation]\n")], [])
    )
    await state.searchPageIds("lexical content", 10)
    expect(sql.queries.some((query) => query.includes("USING fts5"))).toBe(true)
    expect(sql.queries.some((query) => query.includes("INSERT INTO memory_fts"))).toBe(true)
    expect(sql.queries.some((query) => query.includes("memory_fts MATCH"))).toBe(true)
  })
})
