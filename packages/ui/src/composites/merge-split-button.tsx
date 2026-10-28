import { useState } from "react"
import type { PrMergeMethod } from "@jingler/core"
import { ChevronDown } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { ChipMenu } from "../components/chip-menu.js"
import { Spinner } from "../components/loading.js"
import { Tooltip } from "../components/tooltip.js"

/**
 * The three merge strategies, with the button label each one arms.
 *
 * The label changes with the choice rather than staying "Merge pull request":
 * these are not interchangeable — squash rewrites the branch into one commit and
 * rebase discards the merge commit — so the button has to say which is about to
 * happen. GitHub does the same, for the same reason.
 */
const MERGE_METHODS: ReadonlyArray<{ method: PrMergeMethod; action: string; hint: string }> = [
  { method: "merge", action: "Merge pull request", hint: "Keep all commits and add a merge commit" },
  { method: "squash", action: "Squash and merge", hint: "Combine every commit into one on the base branch" },
  { method: "rebase", action: "Rebase and merge", hint: "Replay each commit onto the base, with no merge commit" }
]

const STORAGE_KEY = "jingler.pr.mergeMethod"

// Merge-commit default, matching GitHub and the previous hardcoded behaviour — a
// picker that silently changed what the button did would be a worse regression
// than not having one.
const readMethod = (): PrMergeMethod => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return MERGE_METHODS.find((m) => m.method === stored)?.method ?? "merge"
  } catch {
    return "merge"
  }
}

const rememberMethod = (method: PrMergeMethod): void => {
  try {
    localStorage.setItem(STORAGE_KEY, method)
  } catch {
    // Storage unavailable: the choice just lasts for this mount.
  }
}

export interface MergeSplitButtonProps {
  connected: boolean
  /** Merge with the chosen strategy. */
  onMerge?: (method: PrMergeMethod) => Promise<void> | void
  merging?: boolean
  /** The first merge blocker; when set the button is disabled and shows it as a tooltip. */
  blockedReason?: string | null
  /** A failed merge's message, shown under the button. */
  mergeError?: string | null
}

/** `Squash and merge ▾` — a primary merge action with a chevron picking merge, squash or rebase. The last choice is remembered. */
export function MergeSplitButton({
  connected,
  onMerge,
  merging = false,
  blockedReason = null,
  mergeError
}: MergeSplitButtonProps) {
  const [method, setMethod] = useState<PrMergeMethod>(readMethod)
  const current = MERGE_METHODS.find((m) => m.method === method)!
  const locked = merging || blockedReason !== null
  const split = (
      <div data-testid="merge-split-button" className="flex w-full">
        <Button
          className="flex-1 justify-center gap-2 rounded-r-none"
          disabled={!connected || locked || !onMerge}
          onClick={() => void Promise.resolve(onMerge?.(method)).catch(() => {})}
        >
          {merging && <Spinner size={13} />}
          {merging ? "Merging…" : current.action}
        </Button>
        <ChipMenu
          value={method}
          options={MERGE_METHODS.map((m) => ({
            value: m.method,
            label: m.action,
            ariaLabel: m.action,
            description: m.hint
          }))}
          onSelect={(next) => {
            setMethod(next)
            rememberMethod(next)
          }}
          disabled={locked}
          ariaLabel="Merge method"
          side="top"
          trigger={() => (
            <span
              className={cn(
                "inline-flex h-8 items-center rounded-r-[6px] border-l border-primary-fg/20 px-2",
                locked
                  ? "bg-primary-disabled text-dim"
                  : "cursor-pointer bg-primary-fill text-primary-fg hover:bg-primary-hover"
              )}
            >
              <ChevronDown size={13} aria-hidden />
            </span>
          )}
        />
      </div>
  )
  return (
    <div className="flex flex-col gap-2">
      {blockedReason === null ? (
        split
      ) : (
        // A disabled button gets no pointer events or focus, so a focusable wrapper carries the reason.
        <Tooltip label={blockedReason} wrapperClassName="w-full">
          <span tabIndex={0} className="flex w-full rounded-[6px]">
            {split}
          </span>
        </Tooltip>
      )}
      {mergeError && (
        <Callout tone="red" className="items-start">
          {mergeError}
        </Callout>
      )}
    </div>
  )
}
