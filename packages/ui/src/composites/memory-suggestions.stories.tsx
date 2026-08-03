import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { MemorySuggestionsPanel } from "./memory-suggestions.js"
import { memorySuggestions } from "./memory.mock.js"

/**
 * The advisory "Related pages" panel. Everything it shows is a hint, never an
 * accepted edge — promoting one opens the ordinary cited-wikilink proposal flow.
 * It renders inside the inspector, so it is framed here as a narrow column.
 */
const meta: Meta<typeof MemorySuggestionsPanel> = {
  title: "Composites/Memory/Suggestions",
  component: MemorySuggestionsPanel,
  decorators: [
    (Story) => (
      <div className="w-[360px] bg-panel p-4 text-text">{Story()}</div>
    )
  ],
  args: {
    pageId: "page-billing-overview",
    onOpenPage: fn(),
    onPromote: fn()
  }
}
export default meta
type Story = StoryObj<typeof MemorySuggestionsPanel>

/** Keyword-only relatedness (vectors off). */
export const Lexical: Story = {
  args: { suggestions: memorySuggestions, vectorSource: "lexical" }
}

/** Keyword + embedding relatedness, sourced from turbopuffer. */
export const Embedding: Story = {
  args: { suggestions: memorySuggestions, vectorSource: "turbopuffer" }
}

/** Still fetching neighbours. */
export const Loading: Story = {
  args: { suggestions: [], vectorSource: "turbopuffer", loading: true }
}
