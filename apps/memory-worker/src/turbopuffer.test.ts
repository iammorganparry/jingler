import { Effect } from "effect"
import type { MemoryPage } from "@jingler/memory"
import { describe, expect, it } from "vitest"
import { FakeEmbedder } from "./embeddings.js"
import {
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

  it("08.6 reads the API key only from the Worker env", () => {
    expect(createTurbopufferClientFromEnv({})).toBeUndefined()
    expect(createTurbopufferClientFromEnv({ TURBOPUFFER_API_KEY: "" })).toBeUndefined()
    expect(createTurbopufferClientFromEnv({ TURBOPUFFER_API_KEY: "tpuf-test" })).toBeDefined()
  })
})
