import { SegmentedControl } from "./segmented-control.js"

export type ConflictResolution = "keep-mine" | "replace" | "keep-both"

const ITEMS: ReadonlyArray<{ value: ConflictResolution; label: string }> = [
  { value: "keep-mine", label: "Keep mine" },
  { value: "replace", label: "Replace" },
  { value: "keep-both", label: "Keep both" }
]

/**
 * Import-review badge for a candidate whose name clashes with an existing
 * server. `onChange` is optional: when the apply RPC doesn't yet accept a
 * resolution (current state — see #487 follow-ups), omit it and the control
 * renders read-only, so the operator sees the conflict without a choice that
 * wouldn't do anything.
 */
export function ConflictBadge({
  value,
  onChange
}: {
  readonly value: ConflictResolution
  readonly onChange?: (next: ConflictResolution) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex-none rounded-md border border-line bg-sunken px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-dim">
        Conflict
      </span>
      <SegmentedControl
        aria-label="Conflict resolution"
        items={ITEMS}
        value={value}
        onChange={onChange}
        size="sm"
      />
    </div>
  )
}
