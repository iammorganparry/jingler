import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import type { ReviewTurn } from "./review-turns.js"

const ALL_TURNS = "all"

/** "All turns ▾": narrows the changed-file list and diff to what one agent turn changed. */
export function TurnFilter({
  turns,
  value,
  onChange
}: {
  readonly turns: readonly ReviewTurn[]
  /** The selected turn id, or null for all turns. */
  readonly value: string | null
  readonly onChange: (turnId: string | null) => void
}) {
  return (
    <Select
      value={value ?? ALL_TURNS}
      onValueChange={(next) => onChange(next === ALL_TURNS ? null : next)}
    >
      <SelectTrigger className="h-[30px] min-w-0 rounded-lg text-[12px]" aria-label="Filter by turn">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="right-auto w-[200px]">
        <SelectItem value={ALL_TURNS} textValue="All turns">All turns</SelectItem>
        {turns.map((turn) => (
          <SelectItem key={turn.id} value={turn.id} textValue={turn.label}>
            {turn.label} · {turn.paths.length} {turn.paths.length === 1 ? "file" : "files"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
