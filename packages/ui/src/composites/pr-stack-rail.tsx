import type { PrMergeMethod } from "@jingler/core"
import { mergedBaseOf, restackPlan, type PrCheckStatus, type PrState } from "@jingler/core"
import type { ReactNode } from "react"
import { Check, X } from "lucide-react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Loader } from "../components/beui/loader.js"
import { SegmentedControl } from "../components/segmented-control.js"
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
export type PrStackMergeState = "idle" | "merging" | "restacking" | "failed" | "merged"

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
  /** Continue a failed run from the failed layer. */
  readonly onResume?: () => void
  readonly mergeMethod?: PrMergeMethod
  readonly onMergeMethod?: (method: PrMergeMethod) => void
  /** True while `Github.restack` is running. */
  readonly restacking?: boolean
  /** Retarget and rebase every layer above `mergedPr` (from `restackPlan`). */
  readonly onRestack?: (mergedPr: number) => void
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

/** Per-layer row of a merge run: merged tick, the layer in flight, or nothing yet. */
function layerProgress(index: number, merged: number, mergeState: PrStackMergeState): ReactNode {
  if (index < merged) {
    return mergeState === "restacking" && index === merged - 1 ? (<><Loader size={11} /> Restacking layers above…</>) : (<><Check size={11} /> Merged</>)
  }
  if (index !== merged) return null
  if (mergeState === "merging") return (<><Loader size={11} /> Merging…</>)
  return mergeState === "failed" ? "Failed" : null
}

/** Method picker plus the Merge stack / Resume button. */
function MergeStackActions({ mergeState, merged, total, mergeMethod, onMergeMethod, onMergeStack, onResume }: {
  mergeState: PrStackMergeState
  merged: number
  total: number
  mergeMethod: PrMergeMethod
  onMergeMethod?: (method: PrMergeMethod) => void
  onMergeStack: () => void
  onResume?: () => void
}) {
  const inFlight = mergeState === "merging" || mergeState === "restacking"
  return (
    <>
          {onMergeMethod && mergeState === "idle" && (
            <SegmentedControl
              size="sm"
              aria-label="Merge method"
              value={mergeMethod}
              onChange={onMergeMethod}
              items={[{ value: "merge", label: "Merge" }, { value: "squash", label: "Squash" }, { value: "rebase", label: "Rebase" }]}
            />
          )}
          {mergeState === "failed" && onResume ? (
            <Button variant="secondary" size="sm" data-testid="merge-stack-resume" onClick={onResume}>
              Resume
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              data-testid="merge-stack-cta"
              disabled={inFlight}
              onClick={onMergeStack}
            >
              {inFlight && <Loader size={13} />}
              {inFlight ? `Merging ${merged}/${total}…` : "Merge stack"}
            </Button>
          )}
    </>
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
  onResume,
  mergeMethod = "merge",
  onMergeMethod,
  restacking = false,
  onRestack,
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
  onResume?: () => void
  mergeMethod?: PrMergeMethod
  onMergeMethod?: (method: PrMergeMethod) => void
  restacking?: boolean
  /** Omit to hide the restack actions. */
  onRestack?: (mergedPr: number) => void
  className?: string
}) {
  const plan = onRestack ? restackPlan(layers) : null
  const everyLayerMerged = layers.length > 0 && layers.every((layer) => layer.state === "merged")
  return (
    <nav aria-label="Pull request stack" data-testid="pr-stack-rail" className={cn("relative flex w-[220px] flex-none flex-col", className)}>
      {/* The connector runs through the node centres (px-2 + half of size-3.5). */}
      <span aria-hidden className="absolute bottom-[18px] left-[15px] top-[18px] w-px bg-line" />
      {plan && (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] text-dim">Stack</span>
          <Button variant="secondary" size="sm" data-testid="restack-cta" disabled={restacking} onClick={() => onRestack?.(plan.mergedPr)}>
            {restacking && <Loader size={13} />}
            {restacking ? "Restacking…" : "Restack"}
          </Button>
        </div>
      )}
      {layers.map((layer, index) => {
        const current = layer.number === selected
        const baseMerged = mergedBaseOf(layers, index) !== null
        return (
          <div key={layer.number} className="flex flex-col">
          <Button
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
            {baseMerged ? <Badge tone="yellow" size="xs">Base merged</Badge> : layer.state && <span className="text-[11px] text-dim">{PR_STATE_LABEL[layer.state]}</span>}
          </Button>
          {onMergeStack && layer.state !== "merged" && index > 0 && layers[index - 1]?.state !== "merged" && mergeState !== "merging" && mergeState !== "restacking" && (
            <Button variant="ghost" size="sm" disabled data-testid={`pr-stack-merge-first-${layer.number}`} className="ml-6 h-7 justify-start px-2 text-[11px]">
              Merge #{layers[index - 1]!.number} first
            </Button>
          )}
          {mergeState !== "idle" && (
            <div data-testid={`pr-stack-progress-${layer.number}`} className="ml-6 flex h-7 items-center gap-2 px-2 text-[11px] text-dim">
              {layerProgress(index, merged, mergeState)}
            </div>
          )}
          {baseMerged && onRestack && (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`pr-stack-rebase-${layer.number}`}
              disabled={restacking}
              onClick={() => onRestack(mergedBaseOf(layers, index)!)}
              className="ml-6 h-7 justify-start px-2 text-[11px]"
            >
              Rebase onto main
            </Button>
          )}
          </div>
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
          <MergeStackActions mergeState={mergeState} merged={merged} total={layers.length} mergeMethod={mergeMethod} onMergeMethod={onMergeMethod} onMergeStack={onMergeStack} onResume={onResume} />
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
