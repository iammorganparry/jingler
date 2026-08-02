import type { MemorySuggestion } from "@jingler/contracts"
import { GitPullRequestArrow, Sparkles } from "lucide-react"

export interface MemorySuggestionsPanelProps {
  /** The page currently under inspection; the related page is the other endpoint. */
  pageId: string
  suggestions: ReadonlyArray<MemorySuggestion>
  vectorSource?: "turbopuffer" | "lexical"
  loading?: boolean
  onOpenPage: (pageId: string) => void
  /**
   * Promote a suggestion. The host wires this to the EXISTING cited-wikilink
   * proposal flow — a suggestion is never itself an accepted edge.
   */
  onPromote: (targetPageId: string) => void
}

interface Related {
  readonly id: string
  readonly title: string
}

const relatedEndpoint = (suggestion: MemorySuggestion, pageId: string): Related =>
  suggestion.sourceId === pageId
    ? { id: suggestion.targetId, title: suggestion.targetTitle }
    : { id: suggestion.sourceId, title: suggestion.sourceTitle }

/**
 * A NON-AUTHORITATIVE "related pages" panel. Everything it shows is advisory: a
 * suggestion is a hint, never an accepted graph edge, and promoting one routes
 * through the ordinary cited-wikilink proposal flow rather than mutating the
 * graph directly.
 */
export function MemorySuggestionsPanel({
  pageId,
  suggestions,
  vectorSource = "lexical",
  loading = false,
  onOpenPage,
  onPromote
}: MemorySuggestionsPanelProps) {
  if (!loading && suggestions.length === 0) return null
  return (
    <section
      className="mt-5 border-t border-hairline pt-4"
      aria-labelledby="memory-suggestions-title"
      data-testid="memory-suggestions"
    >
      <div className="flex items-center gap-2">
        <Sparkles size={13} className="text-blue" />
        <h3 id="memory-suggestions-title" className="m-0 text-[11px] font-semibold text-text-bright">
          Related pages
        </h3>
        <span className="rounded border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
          Suggestions · not links
        </span>
      </div>
      <p className="mt-2 text-[10.5px] leading-4 text-muted-foreground">
        Advisory only — inferred by{" "}
        {vectorSource === "turbopuffer" ? "keyword and embedding relatedness" : "keyword relatedness"}.
        These are not accepted edges. Promote one to open a cited wikilink proposal.
      </p>
      {loading && (
        <p role="status" className="mt-2 text-[10.5px] text-muted-foreground">
          Finding related pages…
        </p>
      )}
      <ul className="m-0 mt-3 space-y-2 p-0">
        {suggestions.map((suggestion) => {
          const related = relatedEndpoint(suggestion, pageId)
          const terms = suggestion.evidence.sharedTerms ?? []
          return (
            <li
              key={`${suggestion.sourceId}→${suggestion.targetId}`}
              className="list-none rounded-md border border-line bg-sunken p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onOpenPage(related.id)}
                  className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-text outline-none hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {related.title}
                </button>
                <span className="flex-none rounded border border-line px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  {suggestion.method}
                </span>
              </div>
              {terms.length > 0 && (
                <p className="mt-1 truncate text-[10px] text-dim">shared: {terms.join(", ")}</p>
              )}
              <button
                type="button"
                onClick={() => onPromote(related.id)}
                className="mt-2 flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[10px] font-medium text-blue outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="memory-suggestion-promote"
              >
                <GitPullRequestArrow size={12} /> Propose link
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
