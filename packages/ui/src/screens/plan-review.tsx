import type {
  ExecutionMode,
  Plan,
  PlanAnnotationAnchor,
  PlanCommentMessage,
  PlanDocument,
  PlanDraft
} from "@jingler/core"
import { ClipboardList } from "lucide-react"
import { type ReactNode, useEffect, useRef } from "react"
import { Button } from "../components/button.js"
import { Markdown } from "../components/markdown.js"
import type { PlanEditorSyncState } from "../composites/plan-editor.js"

export interface PlanReviewProps {
  plan: Plan | null
  document?: PlanDocument | null
  streamingDraft?: PlanDraft | null
  draft?: string
  syncState?: PlanEditorSyncState
  syncError?: string | null
  canApprove?: boolean
  patch?: string
  knownFiles?: ReadonlySet<string>
  onOpenFile?: (path: string) => void
  selectedStepId?: string | null
  revisionTarget?: { readonly stageId: string | null } | null
  compact?: boolean
  onSelectStep?: (stepId: string) => void
  onApprove?: (executionMode?: ExecutionMode) => void
  onResume?: () => void
  onRevise?: (feedback?: string) => void
  onComment?: (stepId: string, body: string) => void
  onStartDraft?: () => void
  onSendToAgent?: () => void
  onDiscard?: () => void
  onRetryDocument?: () => void
  onReplyThread?: (
    annotationId: string,
    body: string,
    mentionedParticipantIds: ReadonlyArray<string>
  ) => Promise<void> | void
  onRetryThread?: (
    annotationId: string,
    message: PlanCommentMessage
  ) => Promise<void> | void
  onSetThreadResolved?: (
    annotationId: string,
    resolved: boolean
  ) => Promise<void> | void
  onAddComment?: (
    target: { stageId?: string; anchor?: PlanAnnotationAnchor },
    body: string,
    mentionedParticipantIds: ReadonlyArray<string>
  ) => Promise<void> | void
  pageNav?: ReactNode
}

type Decision = {
  readonly sessionId: string
  readonly chatId: string
  readonly reviewId: string
  readonly approved: boolean
  readonly feedback?: string
}

type PlannotatorBridge = {
  readonly openPlannotator: (payload: unknown) => Promise<void>
  readonly hidePlannotator: (owner: { readonly sessionId: string; readonly chatId: string }) => void
  readonly onPlannotatorDecision: (callback: (decision: Decision) => void) => () => void
}

const bridge = (): PlannotatorBridge | null =>
  (window as unknown as { jingler?: Partial<PlannotatorBridge> }).jingler?.openPlannotator
    ? (window as unknown as { jingler: PlannotatorBridge }).jingler
    : null

export function PlanReview(props: PlanReviewProps) {
  const { plan, document, streamingDraft, onStartDraft } = props

  if (document) return <EmbeddedPlannotator {...props} document={document} />

  if (plan && !streamingDraft) {
    return (
      <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-editor px-3">
        <article aria-label="Legacy plan markdown" className="mx-auto w-full max-w-[760px] py-10">
          <Markdown>{plan.raw}</Markdown>
        </article>
      </div>
    )
  }

  if (streamingDraft) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-editor text-[13px] text-dim">
        Preparing plan…
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-editor text-center">
      <ClipboardList className="size-8 text-line-strong" />
      <div className="max-w-xs text-[13px] leading-[1.5] text-muted-foreground">
        No plan yet. In <span className="font-semibold text-text">Plan</span> mode, ask the agent
        for a change and it will draft one here.
      </div>
      {onStartDraft && (
        <Button size="sm" onClick={onStartDraft}>
          <ClipboardList className="size-3.5" />
          Start a plan
        </Button>
      )}
    </div>
  )
}

function EmbeddedPlannotator({
  document,
  canApprove = true,
  onApprove,
  onRevise,
  pageNav
}: PlanReviewProps & { readonly document: PlanDocument }) {
  const placeholder = useRef<HTMLDivElement | null>(null)
  const owner = { sessionId: document.sessionId, chatId: document.producingChatId }
  const canDecide =
    canApprove &&
    document.reviewId !== undefined &&
    (document.status === "proposed" || document.status === "revising")

  useEffect(() => {
    const api = bridge()
    const element = placeholder.current
    if (!api || !element) return

    const publish = () => {
      const bounds = element.getBoundingClientRect()
      void api.openPlannotator({
        ...owner,
        document,
        canDecide,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      })
    }
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    publish()
    return () => {
      observer.disconnect()
      api.hidePlannotator(owner)
    }
  }, [document, canDecide, owner.sessionId, owner.chatId])

  useEffect(() => {
    const api = bridge()
    if (!api) return
    return api.onPlannotatorDecision((decision) => {
      if (
        decision.sessionId !== owner.sessionId ||
        decision.chatId !== owner.chatId ||
        decision.reviewId !== document.reviewId
      ) return
      if (decision.approved) onApprove?.()
      else onRevise?.(decision.feedback)
    })
  }, [document.reviewId, onApprove, onRevise, owner.sessionId, owner.chatId])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
      {pageNav}
      <div
        ref={placeholder}
        data-testid="plannotator-embedded-view"
        aria-label="Plannotator plan review"
        className="min-h-0 min-w-0 flex-1 bg-editor"
      />
    </div>
  )
}
