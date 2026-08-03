import type { Meta, StoryObj } from "@storybook/react-vite"
import { useMemo, useState } from "react"
import { MemoryBrowser } from "./memory-browser.js"
import { memoryPageDetailsById, memorySearchResults } from "./memory.mock.js"

/**
 * The wiki browser — a lexical search over accepted Markdown, and the page
 * reader you land on when you open a result. The default story is a working
 * harness: type to filter, click a result to read it, and use "Back" to return.
 */
const meta: Meta<typeof MemoryBrowser> = {
  title: "Composites/Memory/Browser",
  component: MemoryBrowser,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[760px] w-full flex-col overflow-hidden bg-panel text-text">
        {Story()}
      </div>
    )
  ]
}
export default meta
type Story = StoryObj<typeof MemoryBrowser>

function BrowserHarness() {
  const [query, setQuery] = useState("")
  const [openId, setOpenId] = useState<string | null>(null)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === "") return memorySearchResults
    return memorySearchResults.filter(
      (result) =>
        result.title.toLowerCase().includes(q) ||
        result.snippet.toLowerCase().includes(q) ||
        result.path.toLowerCase().includes(q)
    )
  }, [query])

  const page = openId ? (memoryPageDetailsById[openId] ?? null) : null

  return (
    <MemoryBrowser
      query={query}
      results={results}
      page={page}
      onQueryChange={setQuery}
      onOpenPage={(id) => setOpenId(id)}
      onBack={() => setOpenId(null)}
    />
  )
}

/** Fully interactive: search, open a page, go back. */
export const Interactive: Story = {
  render: () => <BrowserHarness />
}

/** The results list for a populated query. */
export const SearchResults: Story = {
  args: {
    query: "billing",
    results: memorySearchResults,
    page: null,
    onQueryChange: () => {},
    onOpenPage: () => {},
    onBack: () => {}
  }
}

/** The page reader after opening a result. */
export const PageReader: Story = {
  args: {
    query: "billing",
    results: memorySearchResults,
    page: memoryPageDetailsById["page-billing-overview"] ?? null,
    onQueryChange: () => {},
    onOpenPage: () => {},
    onBack: () => {}
  }
}

/** A query with no matches. */
export const NoMatches: Story = {
  args: {
    query: "kubernetes",
    results: [],
    page: null,
    filter: "uncited",
    onQueryChange: () => {},
    onOpenPage: () => {},
    onBack: () => {}
  }
}

/** Empty state before the first query. */
export const EmptyQuery: Story = {
  args: {
    query: "",
    results: [],
    page: null,
    onQueryChange: () => {},
    onOpenPage: () => {},
    onBack: () => {}
  }
}

/** Mid-search spinner. */
export const Loading: Story = {
  args: {
    query: "invoice",
    results: memorySearchResults,
    page: null,
    loading: true,
    onQueryChange: () => {},
    onOpenPage: () => {},
    onBack: () => {}
  }
}
