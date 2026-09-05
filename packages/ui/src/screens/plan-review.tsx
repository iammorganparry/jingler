import type { PlanDocument, ThemeTokens } from "@jingler/core"
import { useEffect, useRef } from "react"
import { themeCssText, useThemeTokens } from "../theme-provider.js"

export interface PlannotatorOpenPayload {
  readonly sessionId: string
  readonly chatId: string
  readonly document: PlanDocument
  readonly canDecide: boolean
  readonly themeCss: string
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

export const plannotatorThemeCss = (tokens: ThemeTokens): string => `${themeCssText(tokens)}
:root.theme-plannotator.theme-plannotator,
:root .theme-plannotator.theme-plannotator {
  --background: var(--sb-editor);
  --foreground: var(--sb-text);
  --card: var(--sb-panel);
  --card-foreground: var(--sb-text-bright);
  --popover: var(--sb-sunken);
  --popover-foreground: var(--sb-text-bright);
  --primary: var(--sb-brand);
  --primary-foreground: #ffffff;
  --secondary: var(--sb-surface);
  --secondary-foreground: var(--sb-text);
  --muted: var(--sb-panel);
  --muted-foreground: var(--sb-muted);
  --accent: var(--sb-surface);
  --accent-foreground: var(--sb-text-bright);
  --destructive: var(--sb-red);
  --border: var(--sb-line);
  --input: var(--sb-line);
  --ring: var(--sb-brand);
  --success: var(--sb-green);
  --warning: var(--sb-yellow);
  --font-sans: "Hanken Grotesk Variable", "Hanken Grotesk", system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace;
  --radius: 5px;
}
html, body { background: var(--sb-editor); color-scheme: ${tokens.kind === "light" ? "light" : "dark"}; }
`

export interface PlannotatorPlanHost {
  readonly openPlannotator: (payload: PlannotatorOpenPayload) => Promise<void>
  readonly hidePlannotator: (owner: { readonly sessionId: string; readonly chatId: string }) => void
  readonly onPlannotatorDecision: (
    callback: (decision: PlannotatorDecision) => boolean | undefined | Promise<boolean | undefined>
  ) => () => void
}

export interface PlanReviewProps {
  readonly document: PlanDocument
  readonly canApprove?: boolean
  readonly host: PlannotatorPlanHost
  readonly onApprove?: () => void | Promise<void>
  readonly onRevise?: (feedback?: string) => void | Promise<void>
}

export type PlannotatorDecision = {
  readonly sessionId: string
  readonly chatId: string
  readonly reviewId: string
  readonly approved: boolean
  readonly feedback?: string
  readonly deliveryId: string
}

export function PlanReview({
  document,
  canApprove = true,
  host,
  onApprove,
  onRevise
}: PlanReviewProps) {
  const placeholder = useRef<HTMLDivElement | null>(null)
  const tokens = useThemeTokens()
  const themeCss = plannotatorThemeCss(tokens)
  const sessionId = document.sessionId
  const chatId = document.producingChatId
  const canDecide =
    canApprove &&
    document.reviewId !== undefined &&
    (document.status === "proposed" || document.status === "revising")

  useEffect(() => {
    const element = placeholder.current
    if (!element) return

    let frame = 0
    let lastBounds = ""
    const publish = () => {
      const bounds = element.getBoundingClientRect()
      const nextBounds = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`
      if (bounds.width > 0 && bounds.height > 0 && nextBounds !== lastBounds) {
        lastBounds = nextBounds
        host.openPlannotator({
          sessionId,
          chatId,
          document,
          canDecide,
          themeCss,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        }).catch(() => {
          // Closing a chat can destroy the native view while a resize update is in flight.
        })
      }
      frame = requestAnimationFrame(publish)
    }
    frame = requestAnimationFrame(publish)
    return () => {
      cancelAnimationFrame(frame)
      host.hidePlannotator({ sessionId, chatId })
    }
  }, [document, canDecide, sessionId, chatId, host, themeCss])

  useEffect(() => host.onPlannotatorDecision(async (decision) => {
    if (
      decision.sessionId !== sessionId ||
      decision.chatId !== chatId ||
      decision.reviewId !== document.reviewId
    ) return undefined
    const decide = decision.approved ? onApprove : onRevise
    if (!decide) return false
    if (decision.approved) await onApprove?.()
    else await onRevise?.(decision.feedback)
    return true
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
