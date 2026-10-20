import type { PrCheckStatus, PrState } from "@jingler/core"
import { Check, X } from "lucide-react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Loader } from "../components/beui/loader.js"
import { cn } from "../lib/cn.js"

/** One layer of a PR stack. */
export interface PrStackLayer {
  readonly number: number
  readonly title?: string
  readonly branch?: string
  readonly state?: PrState
  readonly checks?: PrCheckStatus | null
}

export const PR_STATE_LABEL: Record<PrState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }

/** `prStackMachine`'s state value while a "Merge stack" run is in flight. */
export type PrStackMergeState = "idle" | "merging" | "failed" | "merged"

/** Stack navigation handed to the PR view: switcher in the header, rail on Checks. */
export interface PrStackNav {
  /** Ordered bottom layer first. */
  readonly layers: ReadonlyArray<PrStackLayer>
  readonly selected: number | null
  readonly onSelect: (number: number) => void
  /** -1 = down the stack, 1 = up. */
  readonly onStep: (delta: -1 | 1) => void
  /** Merge-stack progress, driven by `prStackMachine` in `use-pr-stack.ts`. */
  readonly mergeState: PrStackMergeState
  /** Layers merged so far in the current/last run. */
  readonly merged: number
  readonly mergeError: string | null
  /** Merge every unmerged layer base-up, one RPC per layer; stops on the first failure. */
  readonly onMergeStack: () => void
}

/** Node on the rail: a tick for merged, a cross for failing checks, otherwise a hollow ring. Red is the only colour. */
function LayerNode({ layer }: { layer: PrStackLayer }) {
  const failing = layer.state !== "merged" && layer.checks === "fail"
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 flex size-3.5 flex-none items-center justify-center rounded-full border bg-panel",
        failing ? "border-state-failed text-state-failed" : "border-line-strong text-muted-foreground"
      )}
    >
      {layer.state === "merged" && <Check size={9} strokeWidth={3} />}
      {failing && <X size={9} strokeWidth={3} />}
    </span>
  )
}

/**
 * The stack rail on the Checks tab (Graphite style): h36 rows joined by a 1px line, **base layer first**.
 * The selected layer is marked neutrally (`aria-current`, raised surface); merged layers are dimmed.
 */
export function PrStackRail({
  layers,
  selected,
  onSelect,
  mergeState = "idle",
  merged = 0,
  mergeError = null,
  onMergeStack,
  className
}: {
  /** Ordered bottom layer first. */
  layers: ReadonlyArray<PrStackLayer>
  selected: number | null
  onSelect: (number: number) => void
  /** Merge-stack progress (omit to hide the CTA, e.g. a read-only rail). */
  mergeState?: PrStackMergeState
  merged?: number
  mergeError?: string | null
  onMergeStack?: () => void
  className?: string
}) {
  const everyLayerMerged = layers.length > 0 && layers.every((layer) => layer.state === "merged")
  return (
    <nav aria-label="Pull request stack" data-testid="pr-stack-rail" className={cn("relative flex w-[220px] flex-none flex-col", className)}>
      {/* The connector runs through the node centres (px-2 + half of size-3.5). */}
      <span aria-hidden className="absolute bottom-[18px] left-[15px] top-[18px] w-px bg-line" />
      {layers.map((layer) => {
        const current = layer.number === selected
        return (
          <Button
            key={layer.number}
            variant="ghost"
            aria-current={current ? "true" : undefined}
            data-testid={`pr-stack-layer-${layer.number}`}
            onClick={() => onSelect(layer.number)}
            className={cn(
              "h-9 w-full justify-start gap-2.5 rounded-[6px] px-2 text-left font-normal",
              current && "bg-surface text-text-bright",
              layer.state === "merged" && !current && "opacity-60"
            )}
          >
            <LayerNode layer={layer} />
            <span className="font-mono text-[12px]">#{layer.number}</span>
            <span className="min-w-0 flex-1 truncate text-[12px]">{layer.title ?? layer.branch}</span>
            {layer.state && <span className="text-[11px] text-dim">{PR_STATE_LABEL[layer.state]}</span>}
          </Button>
        )
      })}
      {/*
        Merge order is enforced by the driver (`use-pr-stack.ts`): it walks
        `layers` base-up and stops at the first failure, so there is nothing to
        disable here — only one button, one run. Lower layers stay read-only
        (the session's own write actions target its linked PR, the top layer).
      */}
      {onMergeStack && !everyLayerMerged && (
        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          <Button
            variant="secondary"
            size="sm"
            data-testid="merge-stack-cta"
            disabled={mergeState === "merging"}
            onClick={onMergeStack}
          >
            {mergeState === "merging" && <Loader size={13} />}
            {mergeState === "merging"
              ? `Merging ${merged}/${layers.length}…`
              : mergeState === "failed"
                ? "Retry merge stack"
                : "Merge stack"}
          </Button>
          {mergeState === "failed" && mergeError && (
            <div data-testid="merge-stack-error">
              <Callout tone="red">{mergeError}</Callout>
            </div>
          )}
        </div>
      )}
    </nav>
  )
}
