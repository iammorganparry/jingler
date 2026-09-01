import type { PlanDocument } from "@jingler/core"
import { useEffect, useRef } from "react"

export interface PlannotatorOpenPayload {
  readonly sessionId: string
  readonly chatId: string
  readonly document: PlanDocument
  readonly canDecide: boolean
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

export interface PlannotatorPlanHost {
  readonly openPlannotator: (payload: PlannotatorOpenPayload) => Promise<void>
  readonly hidePlannotator: (owner: { readonly sessionId: string; readonly chatId: string }) => void
  readonly onPlannotatorDecision: (callback: (decision: PlannotatorDecision) => void) => () => void
}

export interface PlanReviewProps {
  readonly document: PlanDocument
  readonly canApprove?: boolean
  readonly host: PlannotatorPlanHost
  readonly onApprove?: () => void
  readonly onRevise?: (feedback?: string) => void
}

export type PlannotatorDecision = {
  readonly sessionId: string
  readonly chatId: string
  readonly reviewId: string
  readonly approved: boolean
  readonly feedback?: string
}

export function PlanReview({
  document,
  canApprove = true,
  host,
  onApprove,
  onRevise
}: PlanReviewProps) {
  const placeholder = useRef<HTMLDivElement | null>(null)
  const sessionId = document.sessionId
  const chatId = document.producingChatId
  const canDecide =
    canApprove &&
    document.reviewId !== undefined &&
    (document.status === "proposed" || document.status === "revising")

  useEffect(() => {
    const element = placeholder.current
    if (!element) return

    const publish = () => {
      const bounds = element.getBoundingClientRect()
      host.openPlannotator({
        sessionId,
        chatId,
        document,
        canDecide,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      }).catch(() => {
        // Closing a chat can destroy the native view while a resize update is in flight.
      })
    }
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    publish()
    return () => {
      observer.disconnect()
      host.hidePlannotator({ sessionId, chatId })
    }
  }, [document, canDecide, sessionId, chatId, host])

  useEffect(() => host.onPlannotatorDecision((decision) => {
    if (
      decision.sessionId !== sessionId ||
      decision.chatId !== chatId ||
      decision.reviewId !== document.reviewId
    ) return
    if (decision.approved) onApprove?.()
    else onRevise?.(decision.feedback)
  }), [document.reviewId, host, onApprove, onRevise, sessionId, chatId])

  return (
    <section
      ref={placeholder}
      data-testid="plannotator-embedded-view"
      aria-label="Plannotator plan review"
      className="min-h-0 min-w-0 flex-1 bg-editor"
    />
  )
}
