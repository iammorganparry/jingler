/**
 * Pure helpers that carve a full unified diff into per-file pieces for the
 * Code Review pane. Kept free of React and RPC so they are unit-testable and
 * so their cost is visible: everything here is one pass over the patch.
 */

/** Lookahead, not a match: splitting on it keeps each `diff --git` header with its block. */
const PATCH_BLOCK_BOUNDARY = /^(?=diff --git )/m

/**
 * Split a full unified diff (which concatenates every changed file) into its
 * per-file `diff --git` blocks ONCE. The previous per-file slice re-split the
 * whole patch for every file — files × lines work that froze the app on a
 * 790k-line changeset.
 */
export const diffBlocks = (diff: string): ReadonlyArray<string> =>
  diff.length === 0 ? [] : diff.split(PATCH_BLOCK_BOUNDARY).filter((block) => block.length > 0)

/**
 * The block whose header names `path` as its destination — `diff --git a/x b/y`
 * ends with the new path — or, for a quoted/unusual header, the block whose
 * `+++` line does. The diff renderer expects only the one file's diff.
 */
export const diffForPath = (blocks: ReadonlyArray<string>, path: string | null): string => {
  if (!path) return ""
  const headerSuffix = ` b/${path}`
  for (const block of blocks) {
    const end = block.indexOf("\n")
    const header = end === -1 ? block : block.slice(0, end)
    if (header.endsWith(headerSuffix)) return block
  }
  const marker = `+++ b/${path}`
  return blocks.find((block) => block.includes(`${marker}\n`) || block.endsWith(marker)) ?? ""
}

