import { useState } from "react"
import { AnimatePresence, m } from "motion/react"
import { Brain, ChevronRight } from "lucide-react"
import { cn } from "../lib/cn.js"
import { SPRING } from "../lib/motion.js"

const secondsLabel = (seconds: number): string =>
  seconds === 1 ? "Thought for 1 second" : `Thought for ${seconds} seconds`

/**
 * The transcript record of the agent's reasoning: a quiet left-aligned line —
 * brain glyph, "Thought for N seconds", chevron — expanding to the full
 * reasoning text beneath it.
 *
 * Collapsed by default on purpose: reasoning is provenance, not content. While
 * the agent is still reasoning (`streaming`) the pill reads "Thinking…" with a
 * pulsing glyph; `seconds` is null until the duration is known.
 */
export function ThoughtBlock({
  seconds,
  streaming = false,
  children,
  defaultOpen = false,
  className
}: {
  seconds: number | null
  streaming?: boolean
  children?: React.ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const collapsible = children != null
  // Historical transcripts settled before durations were recorded keep a
  // timeless past-tense label rather than a forever-"Thinking…".
  const label = streaming
    ? "Thinking…"
    : seconds === null
      ? "Thought for a moment"
      : secondsLabel(seconds)
  return (
    <div className={cn("my-1", className)}>
      {/* A plain left-aligned molecule — no pill, no rules. The reasoning
          record reads as a quiet line in the transcript's flow, not as a
          boundary marker. */}
      <button
        type="button"
        disabled={!collapsible}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex items-center gap-1.5 text-left"
      >
        <Brain
          className={cn("size-3.5 flex-none text-dim", streaming && "animate-pulse-dot")}
        />
        <span className="font-mono text-[10.5px] text-muted-foreground transition-colors group-hover:text-text">
          {label}
        </span>
        {collapsible && (
          <ChevronRight
            className={cn(
              "size-3 flex-none text-dim transition-transform",
              open && "rotate-90"
            )}
          />
        )}
      </button>

      <AnimatePresence initial={false}>
        {collapsible && open && (
          // Deliberately frameless: the reasoning reads as marginalia — small,
          // dim, italic — not as a card competing with the answer.
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING}
            className="overflow-hidden"
          >
            <div className="mt-1.5 pl-5 italic text-[calc(11px*var(--sb-font-scale,1))] leading-[1.6] text-dim">
              {children}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
