import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { FilterChips } from "./filter-chips.js"
import { Kbd } from "./kbd.js"
import { SearchField } from "./search-input.js"

/**
 * Compare with Paper board 09i (Agents & skills): search + kind chips, and the
 * no-results pairing. Also boards 04l, 24a, 19a, 19b.
 */
const meta: Meta = { title: "Atoms/SearchField + FilterChips" }
export default meta
type Story = StoryObj

const KINDS = [
  { value: "all", label: "All", count: 214 },
  { value: "agents", label: "Agents", count: 38 },
  { value: "skills", label: "Skills", count: 176 }
] as const
const EMPTY_KINDS = KINDS.map((k) => ({ ...k, count: 0 }))

function Pair({ initialQuery, results }: { initialQuery: string; results: number }) {
  const [query, setQuery] = useState(initialQuery)
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("all")
  return (
    <div className="flex w-[360px] flex-col gap-2 bg-panel p-4">
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="Search agents and skills"
        kbd={<Kbd>⌘F</Kbd>}
        count={`${results} results`}
      />
      <FilterChips ariaLabel="Kind" options={results === 0 ? EMPTY_KINDS : KINDS} value={kind} onChange={setKind} />
      {results === 0 && <p className="text-[12px] text-muted-foreground">No agents or skills match “{query}”.</p>}
    </div>
  )
}

export const Empty: Story = { render: () => <Pair initialQuery="" results={214} /> }
export const WithQuery: Story = { render: () => <Pair initialQuery="review" results={12} /> }
export const NoResults: Story = { render: () => <Pair initialQuery="zzzz" results={0} /> }
export const CrowdedRow: Story = {
  render: () => (
    <div className="w-[220px] bg-panel p-4">
      <FilterChips ariaLabel="Scope" options={[...KINDS, { value: "pr", label: "PR #482", count: 9 }]} value="all" onChange={() => {}} />
    </div>
  )
}
