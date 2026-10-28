import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { SearchField } from "./search-input.js"
import { VirtualList } from "./virtual-list.js"

/** Compare with Paper boards 09i (Agents & skills) and 22a (mention menu). */
const meta: Meta = { title: "Atoms/VirtualList" }
export default meta
type Story = StoryObj

interface Entry {
  readonly id: string
  readonly name: string
  readonly kind: string
}

const KINDS = ["Agents", "Skills", "Commands", "Files"] as const
const ENTRIES: ReadonlyArray<Entry> = Array.from({ length: 1000 }, (_, i) => ({
  id: `entry-${i}`,
  name: `${KINDS[Math.floor(i / 250)]!.toLowerCase()}-item-${String(i).padStart(4, "0")}`,
  kind: KINDS[Math.floor(i / 250)]!
}))

const getKey = (entry: Entry) => entry.id
const getText = (entry: Entry) => entry.name
const getGroup = (entry: Entry) => entry.kind
const renderRow = (entry: Entry) => <span className="truncate px-3 font-mono text-[12px] text-text-bright">{entry.name}</span>

function Demo({ grouped, initialQuery = "" }: { grouped: boolean; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery)
  const [picked, setPicked] = useState("none")
  return (
    <div className="flex w-[360px] flex-col gap-2 bg-panel p-4">
      <SearchField value={query} onChange={setQuery} placeholder="Search 1,000 rows" />
      <div className="overflow-hidden rounded-lg border border-line">
        <VirtualList
          items={ENTRIES}
          getKey={getKey}
          getText={getText}
          getGroup={grouped ? getGroup : undefined}
          renderRow={renderRow}
          onSelect={(entry) => setPicked(entry.name)}
          query={query}
          ariaLabel="Rows"
        />
      </div>
      <p className="text-[11px] text-muted-foreground">Selected: {picked}. Click the list, then use ↑ ↓ Home End and Enter.</p>
    </div>
  )
}

export const Rows1000: Story = { render: () => <Demo grouped={false} /> }
export const StickyGroups: Story = { render: () => <Demo grouped /> }
export const Filtered: Story = { render: () => <Demo grouped initialQuery="item-00" /> }
export const NoResults: Story = { render: () => <Demo grouped initialQuery="zzz" /> }
