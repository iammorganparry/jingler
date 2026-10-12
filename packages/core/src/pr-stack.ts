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
