import type { SessionPr } from "./domain.js"

/**
 * Where one layer of a PR stack starts and ends. Git revision ranges are null when a
 * branch needed to build them is unknown (e.g. a layer persisted with only its number).
 */
export interface PrLayerRange {
  readonly number: number
  /** What this layer is compared against: the trunk for the bottom layer, else the layer below. */
  readonly base: string | null
  readonly head: string | null
  /** `git log` range: only this layer's own commits (`base..head`). */
  readonly commitRange: string | null
  /** `git diff` range from the merge base (`base...head`). */
  readonly diffRange: string | null
}

/**
 * Per-layer ranges for a stack ordered bottom first. Each layer is measured against the
 * branch of the layer below it, not its stored `base`, which goes stale after a restack;
 * the bottom layer uses its stored base, else `trunk`.
 */
export const prLayerRanges = (prs: ReadonlyArray<SessionPr>, trunk: string): ReadonlyArray<PrLayerRange> =>
  prs.map((pr, index) => {
    const base = index === 0 ? (pr.base ?? trunk) : (prs[index - 1]?.branch ?? null)
    const head = pr.branch ?? null
    const ranged = base !== null && head !== null
    return {
      number: pr.number,
      base,
      head,
      commitRange: ranged ? `${base}..${head}` : null,
      diffRange: ranged ? `${base}...${head}` : null
    }
  })

/** The selected layer's range by PR number, or null when it isn't in the stack. */
export const layerRangeByNumber = (
  ranges: ReadonlyArray<PrLayerRange>,
  number: number
): PrLayerRange | null => ranges.find((range) => range.number === number) ?? null

/** The layers a stack needs restacked once a base layer has merged. */
export interface RestackPlan {
  /** Top-most merged layer with an unmerged layer directly above it; pass to `Github.restack`. */
  readonly mergedPr: number
  /** The one layer whose PR base moves onto the merged layer's base. */
  readonly retarget: number
  /** Every layer above `mergedPr`, bottom first; each is rebased. */
  readonly rebase: ReadonlyArray<number>
}

/** Plan a restack for a bottom-first stack, or null when no unmerged layer sits on a merged one. */
export const restackPlan = (layers: ReadonlyArray<{ readonly number: number; readonly state?: string }>): RestackPlan | null => {
  const at = layers.findLastIndex((layer, index) => layer.state === "merged" && layers[index + 1] !== undefined && layers[index + 1]!.state !== "merged")
  if (at < 0) return null
  const above = layers.slice(at + 1)
  return { mergedPr: layers[at]!.number, retarget: above[0]!.number, rebase: above.map((layer) => layer.number) }
}

/** The merged layer directly under `layers[index]` when that layer itself is unmerged ("Base merged"), else null. */
export const mergedBaseOf = (layers: ReadonlyArray<{ readonly number: number; readonly state?: string }>, index: number): number | null =>
  index > 0 && layers[index]?.state !== "merged" && layers[index - 1]?.state === "merged" ? layers[index - 1]!.number : null
