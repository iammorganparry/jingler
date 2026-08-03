import type { MemoryPageDetail, MemorySearchResult } from "@jingler/contracts"
import { ArrowLeft, BookOpen, FileSearch, Link2, Quote, Search } from "lucide-react"

export interface MemoryBrowserProps {
  query: string
  results: ReadonlyArray<MemorySearchResult>
  page: MemoryPageDetail | null
  loading?: boolean
  filter?: string | null
  onQueryChange: (query: string) => void
  onOpenPage: (pageId: string) => void
  onBack: () => void
}

export function MemoryBrowser({
  query,
  results,
  page,
  loading = false,
  filter = null,
  onQueryChange,
  onOpenPage,
  onBack
}: MemoryBrowserProps) {
  if (page) {
    return (
      <article className="min-h-0 flex-1 overflow-auto p-5" data-testid="memory-page">
        <button type="button" onClick={onBack} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft size={13} /> Back to previous view</button>
        <div className="mx-auto mt-4 max-w-3xl rounded-xl border border-line bg-panel p-6">
          <p className="m-0 font-mono text-[9.5px] text-dim">{page.page.id} · {page.page.path}</p>
          <h1 className="m-0 mt-2 text-2xl font-semibold text-text-bright">{page.page.title}</h1>
          <div className="mt-3 flex flex-wrap gap-1.5">{page.page.tags.map((tag) => <span key={tag} className="rounded-full border border-line px-2 py-1 text-[9.5px] text-muted-foreground">{tag}</span>)}</div>
          <div className="mt-6 whitespace-pre-wrap text-[13px] leading-6 text-text-body">{page.page.body}</div>
          <dl className="mt-8 grid gap-3 border-t border-hairline pt-5 text-[11px] sm:grid-cols-2">
            <div><dt className="flex items-center gap-1.5 text-muted-foreground"><Quote size={12} /> Citations</dt><dd className="m-0 mt-1 font-mono text-text">{page.citationIds.length}</dd></div>
            <div><dt className="flex items-center gap-1.5 text-muted-foreground"><Link2 size={12} /> Backlinks</dt><dd className="m-0 mt-1 font-mono text-text">{page.backlinks.length}</dd></div>
            <div><dt className="text-muted-foreground">Accepted revision</dt><dd className="m-0 mt-1 font-mono text-text">{page.revision.id}</dd></div>
            <div><dt className="text-muted-foreground">Contributors</dt><dd className="m-0 mt-1 font-mono text-text">{page.contributors.join(", ")}</dd></div>
          </dl>
        </div>
      </article>
    )
  }

  return (
    <section className="min-h-0 flex-1 overflow-auto p-5" aria-labelledby="memory-wiki-title">
      <div className="mx-auto max-w-4xl">
        <h1 id="memory-wiki-title" className="m-0 text-xl font-semibold text-text-bright">Wiki browser</h1>
        <p className="mt-1 text-[12px] text-muted-foreground">Search accepted Markdown through the private lexical index.</p>
        <label className="mt-5 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2.5 focus-within:ring-2 focus-within:ring-ring">
          <Search size={15} className="text-muted-foreground" />
          <span className="sr-only">Search team memory</span>
          <input value={query} onChange={(event) => onQueryChange(event.currentTarget.value)} placeholder="Search titles, prose, citations, and wikilinks" className="min-w-0 flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-dim" />
          {loading && <span className="text-[10px] text-muted-foreground">Searching…</span>}
        </label>
        {filter && <p className="mt-2 text-[10.5px] text-blue">Filtered by: {filter}</p>}
        <ul className="m-0 mt-4 overflow-hidden rounded-xl border border-line bg-panel p-0" aria-label="Memory search results">
          {results.length === 0 ? (
            <li className="flex min-h-44 list-none flex-col items-center justify-center gap-2 p-5 text-center text-[11.5px] text-muted-foreground"><FileSearch size={22} className="text-dim" /><span>{query ? "No accepted pages matched." : "Enter a query to search accepted memory."}</span></li>
          ) : results.map((result) => (
            <li className="list-none" key={result.pageId}>
            <button type="button" onClick={() => onOpenPage(result.pageId)} className="flex w-full gap-3 border-b border-hairline p-4 text-left outline-none last:border-b-0 hover:bg-surface/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <BookOpen size={15} className="mt-0.5 flex-none text-blue" />
              <span className="min-w-0 flex-1"><strong className="block truncate text-[12px] font-semibold text-text-bright">{result.title}</strong><span className="mt-0.5 block font-mono text-[9.5px] text-dim">{result.path} · {result.revisionId}</span><span className="mt-2 block line-clamp-2 text-[11px] leading-4 text-muted-foreground">{result.snippet}</span></span>
            </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
