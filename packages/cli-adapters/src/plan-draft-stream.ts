import { sanitizePlanHtml, type StreamEvent } from "@jingler/core"

const OPENING = /^[\t ]*`{4}(?!`)html(?:[\t ]+plan)?[\t ]*\r?\n/im
const CLOSING = /^[\t ]*`{4}(?!`)[\t ]*(?=\r?$)/m
const PLAN_TITLE = /^<h1>\s*(?:PRD|Plan)\s*:/i
const RAW_PLAN_TITLE = /^[\t \r\n]*<h1>\s*(?:PRD|Plan)\s*:/i
export const PLAN_DRAFT_MIN_INTERVAL_MS = 50

export interface PlanDraftStream {
  /** Append a delta and return a cadence-coalesced cumulative draft when due. */
  readonly append: (delta: string) => StreamEvent | null
  /** Replace the cumulative message and return a coalesced draft when due. */
  readonly update: (message: string) => StreamEvent | null
  /** Hide the current draft and discard its transport buffer. */
  readonly clear: () => StreamEvent | null
  /** Discard the transport buffer after atomic canonical promotion. */
  readonly reset: () => void
}

interface ExtractedDraft {
  readonly source: string
  readonly complete: boolean
}

/**
 * Extract only Jingler's top-level four-backtick plan transport.
 *
 * A four-backtick fence alone is not enough: assistant replies can teach with
 * HTML examples. Requiring the plan dialect's leading `PRD:`/`Plan:` h1 keeps
 * those examples in the transcript while tolerating a short prose preamble before
 * a real submission. The HTML parser closes incomplete tags while sanitizing, so
 * token-level snapshots are safe and renderable without pretending the still-open
 * transport is structurally valid.
 */
export const extractPlanDraft = (message: string): ExtractedDraft | null => {
  const opening = OPENING.exec(message)
  if (opening === null) return null
  const bodyStart = opening.index + opening[0].length
  const remainder = message.slice(bodyStart)
  const closing = CLOSING.exec(remainder)
  const raw = remainder.slice(0, closing?.index ?? remainder.length)
  const source = sanitizePlanHtml(raw)
  return source.length === 0 || !PLAN_TITLE.test(source)
    ? null
    : { source, complete: closing !== null }
}

/**
 * Normalize delta-based and cumulative provider streams into idempotent,
 * cumulative `PlanDraft` events.
 */
export const createPlanDraftStream = (
  planId: () => string,
  options: {
    readonly minIntervalMs?: number
    readonly now?: () => number
  } = {}
): PlanDraftStream => {
  let message = ""
  let visible = false
  let lastSnapshot = ""
  let lastProcessedAt = Number.NEGATIVE_INFINITY
  const minIntervalMs = options.minIntervalMs ?? PLAN_DRAFT_MIN_INTERVAL_MS
  const now = options.now ?? Date.now

  const hasCandidate = (): boolean => {
    const opening = OPENING.exec(message)
    return (
      opening !== null &&
      RAW_PLAN_TITLE.test(message.slice(opening.index + opening[0].length))
    )
  }

  // The closing fence must terminate the transport, so inspecting a small tail
  // avoids rescanning the accumulated plan merely to bypass throttling for the
  // final canonical-ready snapshot.
  const hasClosingFence = (): boolean => CLOSING.test(message.slice(-64))

  const snapshot = (): StreamEvent | null => {
    const timestamp = now()
    const complete = hasClosingFence()
    if (!complete) {
      if (lastSnapshot === "" && !hasCandidate()) return null
      if (timestamp - lastProcessedAt < minIntervalMs) return null
    }
    lastProcessedAt = timestamp
    const extracted = extractPlanDraft(message)
    if (extracted === null) return null
    const phase = extracted.complete ? "complete" : "composing"
    const key = `${phase}\u0000${extracted.source}`
    if (key === lastSnapshot) return null
    visible = true
    lastSnapshot = key
    return {
      _tag: "PlanDraft",
      draft: { id: planId(), source: extracted.source, phase }
    }
  }

  const reset = (): void => {
    message = ""
    visible = false
    lastSnapshot = ""
    lastProcessedAt = Number.NEGATIVE_INFINITY
  }

  return {
    append: (delta) => {
      message += delta
      return snapshot()
    },
    update: (next) => {
      message = next
      if (visible && !hasCandidate()) {
        const id = planId()
        visible = false
        lastSnapshot = ""
        lastProcessedAt = Number.NEGATIVE_INFINITY
        return {
          _tag: "PlanDraft",
          draft: { id, source: "", phase: "cleared" }
        }
      }
      return snapshot()
    },
    clear: () => {
      if (!visible) {
        reset()
        return null
      }
      const id = planId()
      reset()
      return {
        _tag: "PlanDraft",
        draft: { id, source: "", phase: "cleared" }
      }
    },
    reset
  }
}
