import { Schema } from "effect"
import { canonicalJson, type MemoryGraph } from "./graph.js"
import type { MemoryPage } from "./model.js"

/**
 * Advisory relatedness suggestions.
 *
 * These are DELIBERATELY not graph edges. A {@link SuggestedLink} is a hint the
 * inspector can surface as "related pages"; promoting one always goes through the
 * normal cited-wikilink proposal flow before it can become an accepted
 * {@link MemoryGraph} edge. Nothing here feeds a reproducible hash — the graph,
 * analytics, index and export manifest are computed only from accepted evidence,
 * and this module never mutates or is read by them.
 *
 * The evidence discriminator mirrors `MemoryGraphEdge`: a {@link SuggestedLink}
 * carries a `method` and its `evidence.method` must agree, and (unlike an edge) a
 * suggestion can never join a page to itself.
 */
export const SuggestionMethod = Schema.Literal("lexical", "embedding")
export type SuggestionMethod = Schema.Schema.Type<typeof SuggestionMethod>

/** Why a deterministic lexical pass believed two pages are related. */
export const LexicalSuggestionEvidence = Schema.Struct({
  method: Schema.Literal("lexical"),
  /** tf-idf cosine similarity of the two page bodies, in [0, 1]. */
  cosine: Schema.Number,
  /** The highest-weight terms the two bodies share, most-relevant first. */
  sharedTerms: Schema.Array(Schema.String),
  /** Tags present on both pages. */
  sharedTags: Schema.Array(Schema.String),
  /** Source/citation ids cited by both pages. */
  sharedSources: Schema.Array(Schema.String),
  /** Schema-entity relationship targets declared by both pages. */
  sharedSchemas: Schema.Array(Schema.String)
})
export type LexicalSuggestionEvidence = Schema.Schema.Type<typeof LexicalSuggestionEvidence>

/** Why a vector nearest-neighbour pass believed two pages are related. */
export const EmbeddingSuggestionEvidence = Schema.Struct({
  method: Schema.Literal("embedding"),
  /** Cosine similarity reported by the vector store, in [0, 1]. */
  cosine: Schema.Number,
  /** The embedding model identifier the vector was produced with. */
  model: Schema.String,
  /** 0-based rank of the neighbour within the source page's result set. */
  neighborRank: Schema.Number
})
export type EmbeddingSuggestionEvidence = Schema.Schema.Type<typeof EmbeddingSuggestionEvidence>

export const SuggestionEvidence = Schema.Union(
  LexicalSuggestionEvidence,
  EmbeddingSuggestionEvidence
)
export type SuggestionEvidence = Schema.Schema.Type<typeof SuggestionEvidence>

export const SuggestedLink = Schema.Struct({
  sourceId: Schema.String,
  targetId: Schema.String,
  method: SuggestionMethod,
  /** Advisory ranking score; higher is more related. Never a probability. */
  score: Schema.Number,
  evidence: SuggestionEvidence
}).pipe(
  Schema.filter((link) =>
    link.sourceId === link.targetId
      ? "a suggested link cannot join a page to itself"
      : link.method !== link.evidence.method
        ? "suggested link method must match its evidence method"
        : true
  )
)
export type SuggestedLink = Schema.Schema.Type<typeof SuggestedLink>

export const SuggestionPolicy = Schema.Struct({
  /** Drop any suggestion scoring below this threshold. */
  minScore: Schema.Number,
  /** Keep at most this many suggestions touching any one page. */
  topK: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  /** Emit both A→B and B→A (`true`) or one canonical A↔B (`false`). */
  directed: Schema.Boolean,
  /** Suppress pairs already joined by an accepted wikilink/dependency edge. */
  excludeExplicit: Schema.Boolean
})
export type SuggestionPolicy = Schema.Schema.Type<typeof SuggestionPolicy>

export const SUGGESTION_POLICY_DEFAULT: SuggestionPolicy = {
  minScore: 0.05,
  topK: 5,
  directed: false,
  excludeExplicit: true
}

// ── Deterministic helpers ────────────────────────────────────────────────────

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000

/** Common English words that carry no topical signal. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may", "new",
  "now", "old", "see", "two", "way", "who", "did", "get", "him", "let", "put",
  "say", "she", "too", "use", "that", "this", "with", "from", "have", "will",
  "your", "they", "them", "then", "than", "were", "when", "what", "which",
  "there", "their", "would", "could", "should", "about", "into", "over", "also",
  "been", "such", "some", "only", "more", "most", "these", "those", "here"
])

const WORD_SPLIT = /[^\p{L}\p{N}]+/u

/** Lowercase, split on non-word runs, drop stopwords and terms shorter than 3. */
export const tokenizeBody = (body: string): ReadonlyArray<string> =>
  body
    .toLocaleLowerCase("en-US")
    .split(WORD_SPLIT)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))

const termFrequencies = (body: string): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const token of tokenizeBody(body)) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

interface DocumentVector {
  readonly page: MemoryPage
  readonly weights: ReadonlyMap<string, number>
  readonly norm: number
}

const buildVectors = (pages: ReadonlyArray<MemoryPage>): ReadonlyArray<DocumentVector> => {
  const frequencies = pages.map((page) => ({ page, terms: termFrequencies(page.body) }))
  const total = frequencies.length
  const documentFrequency = new Map<string, number>()
  for (const doc of frequencies) {
    for (const term of doc.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }
  // Smoothed idf keeps every observed term positive, so a page shared only via a
  // rare term still forms a vector rather than collapsing to zero.
  const idf = (term: string): number =>
    Math.log((total + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1
  return frequencies.map((doc) => {
    const weights = new Map<string, number>()
    for (const [term, count] of doc.terms) weights.set(term, (1 + Math.log(count)) * idf(term))
    let sumSquares = 0
    for (const weight of weights.values()) sumSquares += weight * weight
    return { page: doc.page, weights, norm: Math.sqrt(sumSquares) }
  })
}

const cosineSimilarity = (left: DocumentVector, right: DocumentVector): number => {
  if (left.norm === 0 || right.norm === 0) return 0
  const [smaller, larger] =
    left.weights.size <= right.weights.size ? [left, right] : [right, left]
  let dot = 0
  for (const [term, weight] of smaller.weights) {
    const other = larger.weights.get(term)
    if (other !== undefined) dot += weight * other
  }
  return dot / (left.norm * right.norm)
}

const sharedTopTerms = (
  left: DocumentVector,
  right: DocumentVector,
  cap = 8
): ReadonlyArray<string> => {
  const shared: Array<{ readonly term: string; readonly weight: number }> = []
  for (const [term, weight] of left.weights) {
    const other = right.weights.get(term)
    if (other !== undefined) shared.push({ term, weight: weight + other })
  }
  return shared
    .sort((a, b) => b.weight - a.weight || compareText(a.term, b.term))
    .slice(0, cap)
    .map((entry) => entry.term)
}

const sortedIntersection = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const rightSet = new Set(right)
  return [...new Set(left.filter((value) => rightSet.has(value)))].sort(compareText)
}

const pageSourceIds = (page: MemoryPage): ReadonlyArray<string> => [
  ...page.sources.map((source) => source.id),
  ...page.citations.map((citation) => citation.sourceId)
]

const pageSchemaTargets = (page: MemoryPage): ReadonlyArray<string> =>
  page.relationships
    .filter((relationship) => relationship.kind === "schema")
    .map((relationship) => relationship.target)

const overlapBonus = (
  sharedTags: ReadonlyArray<string>,
  sharedSources: ReadonlyArray<string>,
  sharedSchemas: ReadonlyArray<string>
): number =>
  0.05 * Math.min(sharedTags.length, 3) +
  0.05 * Math.min(sharedSources.length, 3) +
  0.05 * Math.min(sharedSchemas.length, 3)

/** An un-materialized scored pair, before policy filtering and de-duplication. */
export interface SuggestionCandidate {
  readonly sourceId: string
  readonly targetId: string
  readonly method: SuggestionMethod
  readonly score: number
  readonly evidence: SuggestionEvidence
}

const compareCandidate = (left: SuggestionCandidate, right: SuggestionCandidate): number =>
  right.score - left.score ||
  compareText(left.sourceId, right.sourceId) ||
  compareText(left.targetId, right.targetId) ||
  compareText(left.method, right.method)

const PAGE_NODE_PREFIX = "page:"

const stripPageNode = (nodeId: string): string | undefined =>
  nodeId.startsWith(PAGE_NODE_PREFIX) ? nodeId.slice(PAGE_NODE_PREFIX.length) : undefined

const unorderedKey = (left: string, right: string): string =>
  left <= right ? `${left} ${right}` : `${right} ${left}`

/** Page pairs already joined by an accepted wikilink/dependency (either direction). */
const explicitlyLinkedPairs = (graph: MemoryGraph): ReadonlySet<string> => {
  const pairs = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.kind !== "wikilink" && edge.kind !== "backlink" && edge.kind !== "dependency") {
      continue
    }
    const source = stripPageNode(edge.sourceId)
    const target = stripPageNode(edge.targetId)
    if (source !== undefined && target !== undefined) pairs.add(unorderedKey(source, target))
  }
  return pairs
}

/**
 * Apply a {@link SuggestionPolicy} to raw scored pairs: drop self-pairs, drop
 * pairs already joined by an accepted wikilink/dependency edge, apply `minScore`,
 * collapse to canonical id order when undirected, cap per page at `topK`, and
 * emit a stably sorted, decodable {@link SuggestedLink} list.
 *
 * Shared by the lexical pass and the embedding pass so both honour identical
 * advisory-only guarantees.
 */
export const materializeSuggestions = (
  candidates: ReadonlyArray<SuggestionCandidate>,
  policy: SuggestionPolicy,
  graph: MemoryGraph,
  pageId?: string
): ReadonlyArray<SuggestedLink> => {
  const excluded = policy.excludeExplicit ? explicitlyLinkedPairs(graph) : new Set<string>()
  const eligible = candidates.filter(
    (candidate) =>
      candidate.sourceId !== candidate.targetId &&
      (pageId === undefined || candidate.sourceId === pageId || candidate.targetId === pageId) &&
      candidate.score >= policy.minScore &&
      !excluded.has(unorderedKey(candidate.sourceId, candidate.targetId))
  )

  let deduped: ReadonlyArray<SuggestionCandidate>
  if (policy.directed) {
    deduped = eligible
  } else {
    const byPair = new Map<string, SuggestionCandidate>()
    for (const candidate of eligible) {
      const [first, second] =
        candidate.sourceId <= candidate.targetId
          ? [candidate.sourceId, candidate.targetId]
          : [candidate.targetId, candidate.sourceId]
      const canonical: SuggestionCandidate = { ...candidate, sourceId: first, targetId: second }
      const key = `${first} ${second}`
      const existing = byPair.get(key)
      if (existing === undefined || compareCandidate(canonical, existing) < 0) {
        byPair.set(key, canonical)
      }
    }
    deduped = [...byPair.values()]
  }

  const sorted = [...deduped].sort(compareCandidate)
  const perPage = new Map<string, number>()
  const kept: Array<SuggestedLink> = []
  for (const candidate of sorted) {
    const endpoints = policy.directed
      ? [candidate.sourceId]
      : [candidate.sourceId, candidate.targetId]
    if (endpoints.some((id) => (perPage.get(id) ?? 0) >= policy.topK)) continue
    for (const id of endpoints) perPage.set(id, (perPage.get(id) ?? 0) + 1)
    kept.push({
      sourceId: candidate.sourceId,
      targetId: candidate.targetId,
      method: candidate.method,
      score: candidate.score,
      evidence: candidate.evidence
    })
  }
  return kept
}

/**
 * Deterministic lexical relatedness suggestions over accepted page bodies.
 *
 * Pure — the same pages/policy/graph always produce a byte-identical result
 * (see {@link serializeSuggestions}). Uses tf-idf cosine similarity for the score
 * and records shared terms, tags, and source/schema entities as evidence. The
 * `graph` is read only to exclude already-linked pairs; it is never modified.
 */
export const buildLexicalSuggestions = (
  pages: ReadonlyArray<MemoryPage>,
  policy: SuggestionPolicy,
  graph: MemoryGraph,
  pageId?: string
): ReadonlyArray<SuggestedLink> => {
  const vectors = buildVectors(pages)
  const candidates: Array<SuggestionCandidate> = []
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const left = vectors[i]!
      const right = vectors[j]!
      const cosine = cosineSimilarity(left, right)
      if (cosine <= 0) continue
      const sharedTags = sortedIntersection(left.page.tags, right.page.tags)
      const sharedSources = sortedIntersection(
        pageSourceIds(left.page),
        pageSourceIds(right.page)
      )
      const sharedSchemas = sortedIntersection(
        pageSchemaTargets(left.page),
        pageSchemaTargets(right.page)
      )
      const evidence: LexicalSuggestionEvidence = {
        method: "lexical",
        cosine: round6(cosine),
        sharedTerms: sharedTopTerms(left, right),
        sharedTags,
        sharedSources,
        sharedSchemas
      }
      const score = round6(cosine + overlapBonus(sharedTags, sharedSources, sharedSchemas))
      candidates.push({
        sourceId: left.page.id,
        targetId: right.page.id,
        method: "lexical",
        score,
        evidence
      })
      if (policy.directed) {
        candidates.push({
          sourceId: right.page.id,
          targetId: left.page.id,
          method: "lexical",
          score,
          evidence
        })
      }
    }
  }
  return materializeSuggestions(candidates, policy, graph, pageId)
}

/** Stable serialization used to assert byte-reproducibility of a suggestion set. */
export const serializeSuggestions = (
  suggestions: ReadonlyArray<SuggestedLink>
): string => canonicalJson(suggestions)
