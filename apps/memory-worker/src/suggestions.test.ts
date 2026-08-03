import { Effect } from "effect"
import {
  SUGGESTION_POLICY_DEFAULT,
  buildMemoryGraph,
  parseMemoryMarkdown,
  type MemoryPage
} from "@jingler/memory"
import { describe, expect, it } from "vitest"
import type { Embedder } from "./embeddings.js"
import { InMemoryR2Bucket } from "./r2-store.js"
import { combineSuggestions, embeddingCandidates } from "./suggestions.js"
import {
  InMemoryTurbopufferClient,
  TurbopufferVectorLayer,
  type TurbopufferDocument,
  type TurbopufferQueryHit
} from "./turbopuffer.js"
import { InMemoryVaultState, TeamVault } from "./team-vault.js"

// Runs an Effect-returning vault/layer/state method to a Promise at the test boundary.
const run = Effect.runPromise

/** Records upserts so a suggestions() read can be proven to write ZERO vectors. */
class UpsertCountingClient extends InMemoryTurbopufferClient {
  upsertCalls = 0
  upsertedRows = 0

  override upsert(namespace: string, documents: ReadonlyArray<TurbopufferDocument>): Promise<void> {
    this.upsertCalls += 1
    this.upsertedRows += documents.length
    return super.upsert(namespace, documents)
  }
}

const seededPages = (): ReadonlyArray<MemoryPage> =>
  [
    ["garden", "Tomatoes and peppers grow in raised garden beds with compost and mulch."],
    ["compost", "Compost enriches garden soil so peppers and tomatoes thrive in raised beds."],
    ["network", "TCP retransmission windows govern congestion over lossy network links."]
  ].map(([id, body]) => parseMemoryMarkdown(bareMarkdown(id!, body!)))

const bareMarkdown = (id: string, body: string): string =>
  [
    "---",
    `id: ${id}`,
    `title: ${id}`,
    "revision: 1",
    "tags: [shared]",
    "sources: []",
    "citations: []",
    "citationPolicy: none",
    "---",
    `# ${id}`,
    "",
    body,
    ""
  ].join("\n")

const seedVault = async (
  vectorLayer?: TurbopufferVectorLayer
): Promise<TeamVault> => {
  const vault = await run(TeamVault.create(
    "org-suggest",
    new InMemoryVaultState(),
    new InMemoryR2Bucket(),
    vectorLayer
  ))
  const ingest = (id: string, body: string) =>
    run(vault.ingestAcceptedPage({
      revisionId: `revision:${id}`,
      markdown: bareMarkdown(id, body),
      actorId: "tester",
      createdAt: "2026-01-01T00:00:00.000Z"
    }))
  await ingest("garden", "Tomatoes and peppers grow in raised garden beds with compost and mulch.")
  await ingest("compost", "Compost enriches garden soil so peppers and tomatoes thrive in raised beds.")
  await ingest("network", "TCP retransmission windows govern congestion over lossy network links.")
  return vault
}

describe("combineSuggestions", () => {
  const pages: ReadonlyArray<MemoryPage> = []
  const graph = buildMemoryGraph(pages)

  it("turns nearest-neighbour hits into embedding candidates", () => {
    const candidates = embeddingCandidates(
      [
        { sourceId: "a", targetId: "b", cosine: 0.9, rank: 0 },
        { sourceId: "a", targetId: "a", cosine: 1, rank: 0 }
      ],
      "fake-embedding-v1"
    )
    // The self hit is dropped.
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.method).toBe("embedding")
    expect(candidates[0]!.evidence.method).toBe("embedding")
  })

  it("merges lexical and embedding, deterministically", () => {
    const result = combineSuggestions({
      pages,
      graph,
      policy: SUGGESTION_POLICY_DEFAULT,
      neighbors: [{ sourceId: "a", targetId: "b", cosine: 0.9, rank: 0 }],
      embeddingModel: "fake-embedding-v1"
    })
    const again = combineSuggestions({
      pages,
      graph,
      policy: SUGGESTION_POLICY_DEFAULT,
      neighbors: [{ sourceId: "a", targetId: "b", cosine: 0.9, rank: 0 }],
      embeddingModel: "fake-embedding-v1"
    })
    expect(JSON.stringify(result)).toBe(JSON.stringify(again))
    expect(result[0]!.method).toBe("embedding")
    expect(result[0]!.sourceId).toBe("a")
    expect(result[0]!.targetId).toBe("b")
  })
})

describe("vault suggestions endpoint (08.5)", () => {
  it("returns advisory suggestions, never accepted graph edges", async () => {
    const vault = await seedVault()
    const response = await run(vault.suggestions())
    expect(response.vectorSource).toBe("lexical")
    expect(response.suggestions.length).toBeGreaterThan(0)
    for (const link of response.suggestions) {
      expect(link.sourceId).not.toBe(link.targetId)
      expect(link.method).toBe(link.evidence.method)
    }
    // The related gardening pages are suggested.
    const pair = response.suggestions[0]!
    expect(new Set([pair.sourceId, pair.targetId])).toEqual(new Set(["compost", "garden"]))

    // The accepted graph endpoint is entirely separate: it emits NO advisory link.
    const graph = await run(vault.graph({}))
    const suggestionPairs = new Set(
      response.suggestions.map((link) => `${link.sourceId}|${link.targetId}`)
    )
    for (const edge of graph.edges) {
      expect(suggestionPairs.has(`${edge.sourceId}|${edge.targetId}`)).toBe(false)
    }
  })

  it("augments with turbopuffer nearest-neighbours already reconciled by the ingest workflow", async () => {
    const layer = new TurbopufferVectorLayer(new InMemoryTurbopufferClient(), "org-suggest")
    // suggestions() is query-only, so the namespace must be populated out-of-band —
    // exactly what MemoryVectorIngestWorkflow does on accepted publication.
    await run(layer.syncAcceptedPages(seededPages()))
    const vault = await seedVault(layer)
    const response = await run(vault.suggestions())
    expect(response.vectorSource).toBe("turbopuffer")
    // The embedding pass now contributes suggestions from the reconciled namespace.
    const methods = new Set(response.suggestions.map((link) => link.method))
    expect(methods.has("embedding")).toBe(true)
    expect(response.suggestions.length).toBeGreaterThan(0)
  })

  it("is QUERY-ONLY: a suggestions() read never embeds or upserts vectors", async () => {
    const client = new UpsertCountingClient()
    const layer = new TurbopufferVectorLayer(client, "org-suggest")
    // Reconcile the namespace first (the workflow's job); count only reflects that.
    await run(layer.syncAcceptedPages(seededPages()))
    const upsertsAfterReconcile = client.upsertCalls
    expect(upsertsAfterReconcile).toBeGreaterThan(0)

    const vault = await seedVault(layer)
    // Seeding accepted pages must NOT touch the vector layer either.
    expect(client.upsertCalls).toBe(upsertsAfterReconcile)

    const response = await run(vault.suggestions())
    expect(response.vectorSource).toBe("turbopuffer")
    // The read embedded the query + ran ANN, but wrote ZERO vectors.
    expect(client.upsertCalls).toBe(upsertsAfterReconcile)
  })

  it("degrades to lexical when the namespace has not been reconciled yet", async () => {
    // A layer whose namespace is empty (no ingest workflow has run): the ANN query
    // returns nothing, so suggestions fall back to the deterministic lexical pass.
    const layer = new TurbopufferVectorLayer(new InMemoryTurbopufferClient(), "org-suggest")
    const vault = await seedVault(layer)
    const response = await run(vault.suggestions())
    // The empty-namespace query succeeds with no hits, so no embedding suggestions.
    expect(response.suggestions.every((link) => link.method === "lexical")).toBe(true)
    expect(response.suggestions.length).toBeGreaterThan(0)
  })

  // Graceful degradation: ANY OpenAI or turbopuffer failure must yield 200 with
  // lexical-only suggestions — never a 500.
  const emptyVault = (vectorLayer?: TurbopufferVectorLayer): Promise<TeamVault> =>
    run(TeamVault.create("org-empty", new InMemoryVaultState(), new InMemoryR2Bucket(), vectorLayer))

  it("(a) empty org degrades to lexical even with a vector layer present", async () => {
    const layer = new TurbopufferVectorLayer(new InMemoryTurbopufferClient(), "org-empty")
    const vault = await emptyVault(layer)
    const response = await run(vault.suggestions())
    // No pages → no embedding calls, no 500; lexical with no suggestions.
    expect(response.vectorSource).toBe("lexical")
    expect(response.suggestions).toEqual([])
  })

  it("(b) an embedder that throws degrades to lexical, never 500", async () => {
    const failingEmbedder: Embedder = {
      model: "openai-down",
      dims: 1_536,
      embed: () => Promise.reject(new Error("openai unavailable"))
    }
    const layer = new TurbopufferVectorLayer(
      new InMemoryTurbopufferClient(),
      "org-suggest",
      failingEmbedder
    )
    const vault = await seedVault(layer)
    const response = await run(vault.suggestions())
    expect(response.vectorSource).toBe("lexical")
    // The deterministic lexical pass still surfaces the related gardening pages.
    expect(response.suggestions.length).toBeGreaterThan(0)
  })

  it("(c) a turbopuffer query that throws degrades to lexical, never 500", async () => {
    class QueryFailsClient extends InMemoryTurbopufferClient {
      override query(): Promise<ReadonlyArray<TurbopufferQueryHit>> {
        return Promise.reject(new Error("turbopuffer query failed"))
      }
    }
    const layer = new TurbopufferVectorLayer(new QueryFailsClient(), "org-suggest")
    const vault = await seedVault(layer)
    const response = await run(vault.suggestions())
    expect(response.vectorSource).toBe("lexical")
    expect(response.suggestions.length).toBeGreaterThan(0)
  })
})
