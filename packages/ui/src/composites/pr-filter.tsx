import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"

/** One layer a `PrFilter` can select, ordered bottom-of-stack first. */
export interface PrFilterLayer {
  readonly number: number
}

/**
 * "PR: #481 ▾": narrows the changed-file list and diff to one layer of a PR
 * stack. Renders nothing for a single-PR session — `ChangedFilesExplorer`
 * only mounts it once there is a stack to pick from.
 */
export function PrFilter({
  layers,
  value,
  onChange
}: {
  readonly layers: readonly PrFilterLayer[]
  /** The selected layer's PR number. */
  readonly value: number
  readonly onChange: (number: number) => void
}) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger className="h-[30px] min-w-0 rounded-lg text-[12px]" aria-label="Filter by PR layer">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="right-auto w-[160px]">
        {layers.map((layer) => (
          <SelectItem key={layer.number} value={String(layer.number)} textValue={`PR: #${layer.number}`}>
            PR: #{layer.number}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
