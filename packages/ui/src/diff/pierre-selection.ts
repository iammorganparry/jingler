import type { SelectedLineRange, SelectionSide } from "@pierre/diffs"
import { canonicalPierrePath } from "./pierre-model.js"

/** Jingler vocabulary: old is the deletion side, new is the addition side. */
export type JinglerDiffSide = "old" | "new"

/**
 * DOM-independent line selection contract. Both boundaries are one-indexed and
 * inclusive, exactly like Pierre and GitHub review anchors.
 */
export interface JinglerLineSelection {
  readonly path: string
  readonly side: JinglerDiffSide
  readonly startLine: number
  readonly endLine: number
  readonly endSide: JinglerDiffSide
}

export interface PierreCodeViewSelection {
  readonly id: string
  readonly range: SelectedLineRange
}

const jinglerSide = (side: SelectionSide | undefined): JinglerDiffSide =>
  side === "deletions" ? "old" : "new"

const pierreSide = (side: JinglerDiffSide): SelectionSide =>
  side === "old" ? "deletions" : "additions"

const assertLine = (line: number, field: string): void => {
  if (!Number.isInteger(line) || line < 1) {
    throw new Error(`${field} must be a positive one-indexed line number`)
  }
}

export const fromPierreSelectedLineRange = (
  path: string,
  range: SelectedLineRange
): JinglerLineSelection => {
  assertLine(range.start, "Pierre selection start")
  assertLine(range.end, "Pierre selection end")
  const side = jinglerSide(range.side)
  return {
    path: canonicalPierrePath(path),
    side,
    startLine: range.start,
    endLine: range.end,
    endSide: range.endSide === undefined ? side : jinglerSide(range.endSide)
  }
}

export const toPierreSelectedLineRange = (
  selection: JinglerLineSelection
): SelectedLineRange => {
  assertLine(selection.startLine, "Jingler selection startLine")
  assertLine(selection.endLine, "Jingler selection endLine")
  return {
    start: selection.startLine,
    side: pierreSide(selection.side),
    end: selection.endLine,
    endSide: pierreSide(selection.endSide)
  }
}

export const fromPierreCodeViewSelection = (
  selection: PierreCodeViewSelection
): JinglerLineSelection =>
  fromPierreSelectedLineRange(selection.id, selection.range)

export const toPierreCodeViewSelection = (
  selection: JinglerLineSelection
): PierreCodeViewSelection => ({
  id: canonicalPierrePath(selection.path),
  range: toPierreSelectedLineRange(selection)
})

export const isSingleSideSelection = (
  selection: JinglerLineSelection
): boolean => selection.side === selection.endSide

/** The boundary beneath which an inline annotation should be mounted. */
export const selectionAnnotationAnchor = (
  selection: JinglerLineSelection
): { readonly lineNumber: number; readonly side: JinglerDiffSide } => ({
  lineNumber: selection.endLine,
  side: selection.endSide
})
