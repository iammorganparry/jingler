import { Effect } from "effect"
import { stableContentHash, type MemoryPage } from "@jingler/memory"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FakeEmbedder } from "./embeddings.js"
import {
  HttpTurbopufferClient,
  InMemoryTurbopufferClient,
  TurbopufferVectorLayer,
  createTurbopufferClientFromEnv,
  embeddingSnippet,
  turbopufferNamespace,
  type TurbopufferDocument
} from "./turbopuffer.js"

// Runs an Effect-returning vault/layer/state method to a Promise at the test boundary.
const run = Effect.runPromise

const page = (id: string, body: string): MemoryPage => ({
  id,
  path: `${id}.md`,
  title: id,
  revision: 1,
  aliases: [],
  tags: [],
  sources: [],
  citations: [],
  relationships: [],
  body,
  metadata: {}
})

// A fake that records every row upserted with an explicit vector, so "re-embed
// only on content change" (skip upserting unchanged rows) stays observable.
class RecordingTurbopufferClient extends InMemoryTurbopufferClient {
  readonly embedded: Array<string> = []

  override upsert(
    namespace: string,
    documents: ReadonlyArray<TurbopufferDocument>
  ): Promise<void> {
    for (const document of documents) this.embedded.push(document.id)
    return super.upsert(namespace, documents)
  }
}

interface FakeStoredRow {
  readonly id: string
  readonly contentHash: string
  readonly vector: ReadonlyArray<number>
}

/**
 * A minimal fake turbopuffer HTTP backend that honours id-ascending pagination
 * via the v2 `filters: ["id", "Gt", after]` comparison, so it caps every `/query`
 * response at `top_k`. It backs a real {@link HttpTurbopufferClient}, proving the
 * client paginates rather than silently truncating a large namespace.
 */
class PaginatingTurbopufferBackend {
  private readonly rows = new Map<string, FakeStoredRow>()
  queryCount = 0

  seed(rows: ReadonlyArray<FakeStoredRow>): void {
    for (const row of rows) this.rows.set(row.id, row)
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const body = init?.body === undefined ? {} : (JSON.parse(init.body as string) as Record<string, unknown>)
    if (init?.method === "DELETE") {
      this.rows.clear()
      return new Response(null, { status: 200 })
    }
    if (url.endsWith("/query")) {
      this.queryCount += 1
      const filters = body.filters
      const after = Array.isArray(filters) ? (filters[2] as string) : undefined
      const topK = typeof body.top_k === "number" ? body.top_k : 10
      const rows = [...this.rows.values()]
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .filter((row) => after === undefined || row.id > after)
        .slice(0, topK)
        .map((row) => ({ id: row.id, contentHash: row.contentHash }))
      return Response.json({ rows })
    }
    // Namespace-root POST: an upsert (upsert_rows) or a delete (deletes).
    if (Array.isArray(body.deletes)) {
      for (const id of body.deletes as ReadonlyArray<string>) this.rows.delete(id)
      return Response.json({})
    }
    const upsertRows = body.upsert_rows
    if (Array.isArray(upsertRows)) {
      for (const row of upsertRows as ReadonlyArray<{
        readonly id: string
        readonly contentHash: string
        readonly vector: ReadonlyArray<number>
      }>) {
        this.rows.set(row.id, { id: row.id, contentHash: row.contentHash, vector: row.vector })
      }
      return Response.json({})
    }
    return Response.json({})
  }
}

const paddedPage = (index: number): MemoryPage =>
  page(`page-${String(index).padStart(4, "0")}`, `Body number ${index} about gardens and compost.`)

afterEach(() => {
  vi.restoreAllMocks()
})

const gardenA = page("garden", "Tomatoes and peppers grow in raised garden beds with compost.")
const gardenB = page("compost", "Compost enriches garden soil; peppers and tomatoes love raised beds.")
const network = page("network", "TCP retransmission windows govern congestion over lossy links.")

describe("turbopuffer vector layer", () => {
  it("08.3 finds nearest neighbours and excludes self", async () => {
    const client = new InMemoryTurbopufferClient()
    const layer = new TurbopufferVectorLayer(client, "org-1")
    await run(layer.syncAcceptedPages([gardenA, gardenB, network]))

    const related = await run(layer.relatedness(gardenA, 5))
    expect(related.every((neighbor) => neighbor.targetId !== gardenA.id)).toBe(true)
    // The other gardening page is the top neighbour, ahead of the networking page.
    expect(related[0]!.targetId).toBe("compost")
    expect(related[0]!.rank).toBe(0)
    const compostRank = related.findIndex((n) => n.targetId === "compost")
    const networkRank = related.findIndex((n) => n.targetId === "network")
    expect(compostRank).toBeLessThan(networkRank)
  })

  it("08.3 re-embeds only when page content changes", async () => {
    const client = new RecordingTurbopufferClient()
    const layer = new TurbopufferVectorLayer(client, "org-1")

    const first = await run(layer.syncAcceptedPages([gardenA, gardenB]))
    expect(first.embedded).toBe(2)
    expect(client.embedded).toEqual(["garden", "compost"])

    // Identical pages → nothing re-upserted (skipped via the stored content hashes).
    const second = await run(layer.syncAcceptedPages([gardenA, gardenB]))
    expect(second.embedded).toBe(0)
    expect(second.unchanged).toBe(2)
    expect(client.embedded).toEqual(["garden", "compost"])

    // Changing one body re-embeds exactly one.
    const editedB = page("compost", "Compost now also covers worm castings and leaf mould.")
    const third = await run(layer.syncAcceptedPages([gardenA, editedB]))
    expect(third.embedded).toBe(1)
    expect(third.unchanged).toBe(1)
    expect(client.embedded).toEqual(["garden", "compost", "compost"])
  })

  it("08.6 isolates namespaces per organization", async () => {
    const client = new InMemoryTurbopufferClient()
    const orgOne = new TurbopufferVectorLayer(client, "org-one")
    const orgTwo = new TurbopufferVectorLayer(client, "org-two")
    await run(orgOne.syncAcceptedPages([gardenA]))
    await run(orgTwo.syncAcceptedPages([network]))

    expect(orgOne.namespaceName()).not.toBe(orgTwo.namespaceName())
    expect(client.namespaceKeys()).toEqual(
      [turbopufferNamespace("org-one"), turbopufferNamespace("org-two")].sort()
    )
    // A query in org-one never sees org-two's document.
    const crossOne = await run(orgOne.relatedness(network, 5))
    expect(crossOne.map((n) => n.targetId)).not.toContain("network")
  })

  it("08.6 stores only explicit vectors and flat attributes, never full bodies", async () => {
    const client = new InMemoryTurbopufferClient()
    const layer = new TurbopufferVectorLayer(client, "org-1")
    await run(layer.syncAcceptedPages([gardenA]))
    const hits = await run(layer.relatedness(gardenB, 5))
    const hit = hits.find((n) => n.targetId === "garden")
    expect(hit).toBeDefined()
    // The stored head carries only id + content hash; no page body leaks in.
    const heads = await client.heads(turbopufferNamespace("org-1"))
    expect(heads).toHaveLength(1)
    expect(Object.keys(heads[0]!).sort()).toEqual(["contentHash", "id"])
  })

  it("08.6 embeds only a bounded snippet, never a full large body", () => {
    // A body far larger than the cap is truncated before it can be embedded, so
    // full page bodies never reach turbopuffer (only the resulting vector does).
    const longBody = "solar ".repeat(5_000)
    const snippet = embeddingSnippet(page("bulky", longBody))
    expect(longBody.length).toBeGreaterThan(1_024)
    expect(snippet.length).toBe(1_024)
    // A short body is passed through whole (already inherently bounded).
    expect(embeddingSnippet(gardenA)).toBe(gardenA.body)
  })

  it("08.6 is rebuildable from R2-derived pages", async () => {
    const client = new InMemoryTurbopufferClient()
    const layer = new TurbopufferVectorLayer(client, "org-1")
    await run(layer.syncAcceptedPages([gardenA, gardenB, network]))
    const before = await run(layer.relatedness(gardenA, 5))

    // A rebuild drops the namespace and re-embeds from the supplied pages.
    const summary = await run(layer.rebuild([gardenA, gardenB, network]))
    expect(summary.embedded).toBe(3)
    const after = await run(layer.relatedness(gardenA, 5))
    expect(after.map((n) => n.targetId)).toEqual(before.map((n) => n.targetId))
  })

  it("08.6 upserts precomputed vectors from the injected embedder", async () => {
    // The client stores whatever vector the embedder produced — the embedder embeds,
    // the client never does. A 4-dim embedder yields 4-dim stored rows.
    const embedder = new FakeEmbedder("fake-embedding-v1", 4)
    const client = new InMemoryTurbopufferClient()
    const layer = new TurbopufferVectorLayer(client, "org-dims", embedder)
    await run(layer.syncAcceptedPages([gardenA, gardenB]))
    const hits = await run(layer.relatedness(gardenB, 5))
    expect(hits.map((n) => n.targetId)).toContain("garden")
    expect(layer.embeddingModel).toBe("fake-embedding-v1")
  })

  it("08.7 paginates heads() past a single page so the whole namespace is returned", async () => {
    const backend = new PaginatingTurbopufferBackend()
    const total = 2_500
    backend.seed(
      Array.from({ length: total }, (_unused, index) => ({
        id: `page-${String(index).padStart(4, "0")}`,
        contentHash: `hash-${index}`,
        vector: []
      }))
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const client = new HttpTurbopufferClient({ apiKey: "tpuf-test", fetch: backend.fetch })

    const heads = await client.heads("ns-1")

    // Every id is returned, including the tail that a single top_k would drop.
    expect(heads).toHaveLength(total)
    expect(heads.at(-1)?.id).toBe("page-2499")
    expect(new Set(heads.map((head) => head.id)).size).toBe(total)
    // 2500 rows at 1000/page → three paginated queries, not one truncated query.
    expect(backend.queryCount).toBe(3)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("08.7 does not re-embed the tail of a namespace larger than one heads page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const backend = new PaginatingTurbopufferBackend()
    const client = new HttpTurbopufferClient({ apiKey: "tpuf-test", fetch: backend.fetch })
    const pages = Array.from({ length: 2_500 }, (_unused, index) => paddedPage(index))
    const layer = new TurbopufferVectorLayer(client, "org-large")

    const first = await run(layer.syncAcceptedPages(pages))
    expect(first.embedded).toBe(2_500)

    // A second sync with the same pages must skip ALL of them — the tail beyond
    // the first page is only skippable when heads() paginated it into the map.
    const second = await run(layer.syncAcceptedPages(pages))
    expect(second.embedded).toBe(0)
    expect(second.unchanged).toBe(2_500)
    // Sanity: the stored head for a tail page carries the current body's hash.
    const heads = await client.heads(turbopufferNamespace("org-large"))
    const tail = heads.find((head) => head.id === "page-2499")
    expect(tail?.contentHash).toBe(stableContentHash(pages[2_499]!.body))
  })

  it("08.6 reads the API key only from the Worker env", () => {
    expect(createTurbopufferClientFromEnv({})).toBeUndefined()
    expect(createTurbopufferClientFromEnv({ TURBOPUFFER_API_KEY: "" })).toBeUndefined()
    expect(createTurbopufferClientFromEnv({ TURBOPUFFER_API_KEY: "tpuf-test" })).toBeDefined()
  })

  it("throws on a non-ok write so the durable step retries instead of reporting a phantom upsert", async () => {
    // A 429/5xx on a write must NOT be swallowed: otherwise syncAcceptedPages would
    // report embedded/upserted counts for vectors that never landed.
    const failing: typeof fetch = async () =>
      new Response("rate limited", { status: 429 })
    const client = new HttpTurbopufferClient({ apiKey: "tpuf-test", fetch: failing })
    const document: TurbopufferDocument = {
      id: "page-1",
      vector: [0.1, 0.2, 0.3, 0.4],
      attributes: { contentHash: "hash-1", path: "page-1.md", title: "Page 1", revision: 1 }
    }
    await expect(client.upsert("ns-1", [document])).rejects.toThrow(/turbopuffer upsert failed with status 429/)
    await expect(client.deleteByIds("ns-1", ["page-1"])).rejects.toThrow(/turbopuffer deleteByIds failed with status 429/)
    await expect(client.deleteNamespace("ns-1")).rejects.toThrow(/turbopuffer deleteNamespace failed with status 429/)
  })

  it("treats a 404 deleteNamespace as an idempotent no-op", async () => {
    const missing: typeof fetch = async () => new Response(null, { status: 404 })
    const client = new HttpTurbopufferClient({ apiKey: "tpuf-test", fetch: missing })
    await expect(client.deleteNamespace("ns-absent")).resolves.toBeUndefined()
  })
})
