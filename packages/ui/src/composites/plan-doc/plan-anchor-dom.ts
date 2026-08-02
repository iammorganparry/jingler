import { buildPlanAnchor, type PlanAnnotationAnchor, resolvePlanAnchor } from "@jingler/core"

/**
 * DOM <-> string adapters for plan comment anchors.
 *
 * Core's `plan-anchor.ts` works on a flat text string (`@jingler/core` has no DOM
 * types), so these helpers bridge a rendered read-only plan element to that flat
 * basis: one text basis — `Range.selectNodeContents(root).toString()` — matches a
 * `SHOW_TEXT` TreeWalker's concatenation, so character offsets are consistent in
 * both directions. Highlights are drawn as overlay rects from the recovered DOM
 * Range; the sanitized content is never mutated, so re-render/re-resolve is stable.
 */

const rootText = (root: Node): string => {
  const range = (root.ownerDocument ?? document).createRange()
  range.selectNodeContents(root)
  return range.toString()
}

const charOffsetOfPoint = (root: Node, node: Node, offset: number): number => {
  const range = (root.ownerDocument ?? document).createRange()
  range.selectNodeContents(root)
  range.setEnd(node, offset)
  return range.toString().length
}

const pointAtOffset = (
  root: Node,
  target: number
): { readonly node: Text; readonly offset: number } | null => {
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let consumed = 0
  let last: Text | null = null
  for (let n = walker.nextNode() as Text | null; n !== null; n = walker.nextNode() as Text | null) {
    const len = n.data.length
    if (target <= consumed + len) return { node: n, offset: target - consumed }
    consumed += len
    last = n
  }
  if (last !== null && target === consumed) return { node: last, offset: last.data.length }
  return null
}

export const buildAnchorFromRange = (root: HTMLElement, range: Range): PlanAnnotationAnchor | null => {
  if (range.collapsed) return null
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = charOffsetOfPoint(root, range.startContainer, range.startOffset)
  const end = charOffsetOfPoint(root, range.endContainer, range.endOffset)
  if (end <= start) return null
  return buildPlanAnchor(rootText(root), start, end)
}

export const domRangeFromAnchor = (root: HTMLElement, anchor: PlanAnnotationAnchor): Range | null => {
  const found = resolvePlanAnchor(rootText(root), anchor)
  if (found === null) return null
  const start = pointAtOffset(root, found.start)
  const end = pointAtOffset(root, found.end)
  if (start === null || end === null) return null
  const range = (root.ownerDocument ?? document).createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}
