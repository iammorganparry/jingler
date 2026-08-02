import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  buildMemoryAnalytics,
  buildMemoryGraph,
  buildMemoryIndex,
  buildExportManifest,
  canonicalJson,
  parseMemoryPage,
  serializeMemoryGraph,
  type MemoryPage
} from "./index.js"
import {
  SUGGESTION_POLICY_DEFAULT,
  SuggestedLink,
  buildLexicalSuggestions,
  materializeSuggestions,
  serializeSuggestions,
  tokenizeBody,
  type SuggestionCandidate,
  type SuggestionPolicy
} from "./suggest.js"

const page = (
  id: string,
  body: string,
  extra: {
    readonly tags?: ReadonlyArray<string>
    readonly links?: ReadonlyArray<string>
  } = {}
): MemoryPage => {
  const frontmatter = [
    "---",
    `id: ${id}`,
    `title: ${id}`,
    "revision: 1",
    `tags: [${(extra.tags ?? []).join(", ")}]`,
    "sources: []",
    "citations: []",
    "citationPolicy: none",
    "---",
    `# ${id}`,
    "",
    body,
    ...(extra.links ?? []).map((target) => `See [[${target}]].`),
    ""
  ].join("\n")
  return parseMemoryPage(`${id}.md`, frontmatter)
}

// Two pages that clearly share vocabulary, plus one unrelated page.
const corpus = (): ReadonlyArray<MemoryPage> => [
  page("garden", "Tomatoes and peppers grow best in raised garden beds with compost.", {
    tags: ["gardening", "soil"]
  }),
  page("compost", "Compost enriches garden soil; peppers and tomatoes love raised beds.", {
    tags: ["gardening", "soil"]
  }),
  page("networking", "TCP retransmission windows govern congestion over lossy links.", {
    tags: ["networking"]
  })
]

describe("lexical suggestions", () => {
  it("08.1 is deterministic and byte-reproducible", () => {
    const pages = corpus()
    const graph = buildMemoryGraph(pages)
    const first = buildLexicalSuggestions(pages, SUGGESTION_POLICY_DEFAULT, graph)
    const second = buildLexicalSuggestions(pages, SUGGESTION_POLICY_DEFAULT, graph)
    expect(serializeSuggestions(first)).toBe(serializeSuggestions(second))
    // Every emitted link decodes against the schema (evidence discriminator holds).
    for (const link of first) expect(() => Schema.decodeUnknownSync(SuggestedLink)(link)).not.toThrow()
    // The related gardening pages surface; the networking page does not.
    expect(first.length).toBeGreaterThan(0)
    const pair = first[0]!
    expect(new Set([pair.sourceId, pair.targetId])).toEqual(new Set(["compost", "garden"]))
    expect(pair.method).toBe("lexical")
    expect(pair.evidence.method).toBe("lexical")
  })

  it("08.1 never alters graph, analytics, index, or export hashes", () => {
    const pages = corpus()
    const graph = buildMemoryGraph(pages)
    const before = {
      graph: canonicalJson(graph),
      analytics: canonicalJson(buildMemoryAnalytics(pages)),
      index: canonicalJson(buildMemoryIndex(pages)),
      manifest: canonicalJson(buildExportManifest(pages))
    }
    buildLexicalSuggestions(pages, SUGGESTION_POLICY_DEFAULT, graph)
    expect(canonicalJson(buildMemoryGraph(pages))).toBe(before.graph)
    expect(canonicalJson(buildMemoryAnalytics(pages))).toBe(before.analytics)
    expect(canonicalJson(buildMemoryIndex(pages))).toBe(before.index)
    expect(canonicalJson(buildExportManifest(pages))).toBe(before.manifest)
    // The graph object passed in is untouched.
    expect(serializeMemoryGraph(graph)).toBe(before.graph)
  })

  it("tokenizes with stopwords and a min length", () => {
    expect(tokenizeBody("The cat and a DOG run")).toEqual(["cat", "dog", "run"])
  })
})

describe("materialize policy", () => {
  const graphOf = (pages: ReadonlyArray<MemoryPage>) => buildMemoryGraph(pages)

  it("08.2 excludes self-pairs and already-wikilinked pairs", () => {
    // a links to b, so an a↔b suggestion must be suppressed when excludeExplicit.
    const pages = [
      page("alpha", "Shared vocabulary about turbines and rotors and blades.", { links: ["beta"] }),
      page("beta", "Shared vocabulary about turbines and rotors and blades.")
    ]
    const graph = graphOf(pages)
    const suggestions = buildLexicalSuggestions(pages, SUGGESTION_POLICY_DEFAULT, graph)
    expect(suggestions).toHaveLength(0)

    // With excludeExplicit off the pair returns.
    const permissive: SuggestionPolicy = { ...SUGGESTION_POLICY_DEFAULT, excludeExplicit: false }
    const relaxed = buildLexicalSuggestions(pages, permissive, graph)
    expect(relaxed.length).toBe(1)
    expect(relaxed.every((link) => link.sourceId !== link.targetId)).toBe(true)
  })

  it("08.2 honours minScore, topK, and symmetric dedup", () => {
    const graph = buildMemoryGraph([])
    const candidate = (
      sourceId: string,
      targetId: string,
      score: number
    ): SuggestionCandidate => ({
      sourceId,
      targetId,
      method: "lexical",
      score,
      evidence: {
        method: "lexical",
        cosine: score,
        sharedTerms: [],
        sharedTags: [],
        sharedSources: [],
        sharedSchemas: []
      }
    })

    // Symmetric dedup: a→b and b→a collapse to one canonical a↔b (source <= target).
    const undirected = materializeSuggestions(
      [candidate("b", "a", 0.9), candidate("a", "b", 0.9)],
      SUGGESTION_POLICY_DEFAULT,
      graph
    )
    expect(undirected).toHaveLength(1)
    expect(undirected[0]!.sourceId).toBe("a")
    expect(undirected[0]!.targetId).toBe("b")

    // minScore drops the low pair.
    const thresholded = materializeSuggestions(
      [candidate("a", "b", 0.9), candidate("a", "c", 0.01)],
      SUGGESTION_POLICY_DEFAULT,
      graph
    )
    expect(thresholded.map((link) => link.targetId)).not.toContain("c")

    // topK caps how many suggestions touch a single page.
    const capped = materializeSuggestions(
      [
        candidate("hub", "one", 0.9),
        candidate("hub", "two", 0.8),
        candidate("hub", "three", 0.7)
      ],
      { minScore: 0, topK: 2, directed: true, excludeExplicit: false },
      graph
    )
    expect(capped).toHaveLength(2)
    expect(capped.map((link) => link.targetId)).toEqual(["one", "two"])
  })
})
