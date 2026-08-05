import type { PrReviewThread, ReviewFinding } from "@jingler/core"
import type { DiffLineAnnotation } from "@pierre/diffs"
import type { HTMLAttributes, ReactNode } from "react"
import { cn } from "../lib/cn.js"
import { canonicalPierrePath } from "./pierre-model.js"
import {
  selectionAnnotationAnchor,
  type JinglerDiffSide,
  type JinglerLineSelection
} from "./pierre-selection.js"

interface AnnotationIdentity {
  readonly id: string
}

export interface PierreInlineComposerAnnotation extends AnnotationIdentity {
  readonly kind: "inline-composer"
  readonly selection: JinglerLineSelection
  readonly connected: boolean
  readonly routeTargetSession: string | null
  readonly initialBody?: string
}

export interface PierreSavedReviewDraft {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly endLine: number | null
  readonly body: string
  readonly routeToAgent: boolean
}

export interface PierreSavedDraftAnnotation extends AnnotationIdentity {
  readonly kind: "saved-draft"
  readonly draft: PierreSavedReviewDraft
}

export interface PierreReviewThreadAnnotation extends AnnotationIdentity {
  readonly kind: "review-thread"
  readonly thread: PrReviewThread
}

export interface PierreFindingAnnotation extends AnnotationIdentity {
  readonly kind: "finding"
  readonly finding: ReviewFinding
}

export interface PierreSelectedRangeAction {
  readonly id: string
  readonly label: string
  readonly accessibleLabel?: string
  readonly disabled?: boolean
  readonly intent?: "default" | "primary" | "danger"
}

export interface PierreSelectedRangeActionsAnnotation extends AnnotationIdentity {
  readonly kind: "selected-range-actions"
  readonly selection: JinglerLineSelection
  readonly actions: readonly PierreSelectedRangeAction[]
}

export type PierreAnnotationPayload =
  | PierreInlineComposerAnnotation
  | PierreSavedDraftAnnotation
  | PierreReviewThreadAnnotation
  | PierreFindingAnnotation
  | PierreSelectedRangeActionsAnnotation

/** Non-union metadata envelope keeps Pierre's conditional generic distributive-safe. */
export interface PierreAnnotationMetadata {
  readonly payload: PierreAnnotationPayload
}

export interface PierreAnnotationLocation {
  readonly path: string
  readonly lineNumber: number
  readonly side: JinglerDiffSide
}

/** Resolve application payloads onto Pierre's documented line annotation API. */
export const pierreAnnotationLocation = (
  payload: PierreAnnotationPayload
): PierreAnnotationLocation | null => {
  switch (payload.kind) {
    case "inline-composer":
    case "selected-range-actions": {
      const anchor = selectionAnnotationAnchor(payload.selection)
      return {
        path: canonicalPierrePath(payload.selection.path),
        ...anchor
      }
    }
    case "saved-draft":
      if (payload.draft.line < 1 || (payload.draft.endLine ?? 1) < 1) return null
      return {
        path: canonicalPierrePath(payload.draft.path),
        lineNumber: payload.draft.endLine ?? payload.draft.line,
        side: "new"
      }
    case "review-thread": {
      const lineNumber = payload.thread.line ?? payload.thread.originalLine
      if (lineNumber === null || lineNumber < 1) return null
      return {
        path: canonicalPierrePath(payload.thread.path),
        lineNumber,
        side: "new"
      }
    }
    case "finding":
      if (payload.finding.path === null) return null
      if ((payload.finding.endLine ?? payload.finding.line ?? 0) < 1) return null
      return {
        path: canonicalPierrePath(payload.finding.path),
        lineNumber: payload.finding.endLine ?? payload.finding.line ?? 0,
        side: "new"
      }
  }
}

/**
 * Create a typed Pierre diff annotation. Repository-wide findings return null
 * because they have no file host; callers keep those in the findings rail.
 */
export const createPierreDiffAnnotation = (
  payload: PierreAnnotationPayload
): DiffLineAnnotation<PierreAnnotationMetadata> | null => {
  const location = pierreAnnotationLocation(payload)
  if (location === null) return null
  return {
    side: location.side === "old" ? "deletions" : "additions",
    lineNumber: location.lineNumber,
    metadata: { payload }
  }
}

export interface PierreAnnotationRegionProps
  extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  readonly label: string
  readonly payload: PierreAnnotationPayload
  readonly children: ReactNode
}

/** Stable, labelled annotation host; consumers never address Pierre's slots. */
export function PierreAnnotationRegion({
  label,
  payload,
  className,
  children,
  ...props
}: PierreAnnotationRegionProps) {
  return (
    <section
      {...props}
      aria-label={label}
      data-jingler-pierre-annotation={payload.kind}
      className={cn(
        "border-y border-hairline bg-panel text-text-body",
        className
      )}
    >
      {children}
    </section>
  )
}
