import {
  buildLexicalSuggestions,
  materializeSuggestions,
  type MemoryGraph,
  type MemoryPage,
  type SuggestedLink,
  type SuggestionCandidate,
  type SuggestionPolicy
} from "@jingler/memory"
import type { TurbopufferNeighbor } from "./turbopuffer.js"

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000

/** Turn turbopuffer nearest-neighbour hits into scored suggestion candidates. */
export const embeddingCandidates = (
  neighbors: ReadonlyArray<TurbopufferNeighbor>,
  model: string
): ReadonlyArray<SuggestionCandidate> =>
  neighbors
    .filter((neighbor) => neighbor.sourceId !== neighbor.targetId)
    .map((neighbor) => ({
      sourceId: neighbor.sourceId,
      targetId: neighbor.targetId,
      method: "embedding" as const,
      score: round6(neighbor.cosine),
      evidence: {
        method: "embedding" as const,
        cosine: round6(neighbor.cosine),
        model,
        neighborRank: neighbor.rank
      }
    }))

export interface CombineSuggestionsInput {
  readonly pages: ReadonlyArray<MemoryPage>
  readonly graph: MemoryGraph
  readonly policy: SuggestionPolicy
  /** Empty when turbopuffer is unconfigured — suggestions then degrade to lexical only. */
  readonly neighbors: ReadonlyArray<TurbopufferNeighbor>
  readonly embeddingModel: string
  /** Optional accepted page id; filters the full candidate set before top-K. */
  readonly pageId?: string
}

/**
 * Combine the deterministic lexical pass with turbopuffer nearest-neighbour hits
 * into one bounded, policy-filtered {@link SuggestedLink} set. A pair supported by
 * both methods is kept once, with whichever evidence scored higher. The result is
 * advisory only: it is never an accepted edge and never feeds a reproducible hash.
 */
export const combineSuggestions = (input: CombineSuggestionsInput): ReadonlyArray<SuggestedLink> => {
  const lexical = buildLexicalSuggestions(input.pages, input.policy, input.graph, input.pageId)
  const embedding = materializeSuggestions(
    embeddingCandidates(input.neighbors, input.embeddingModel),
    input.policy,
    input.graph,
    input.pageId
  )
  // A SuggestedLink is a valid SuggestionCandidate, so a final pass unifies the
  // two sources under one set of policy guarantees (self/explicit/minScore/topK/dedup).
  return materializeSuggestions(
    [...lexical, ...embedding],
    input.policy,
    input.graph,
    input.pageId
  )
}
