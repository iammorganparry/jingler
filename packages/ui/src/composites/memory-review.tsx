import type { MemoryReviewItem, MemoryReviewResult } from "@jingler/contracts"
import { AlertTriangle, Check, ChevronRight, FileDiff, X } from "lucide-react"
import { useState } from "react"

export interface MemoryReviewProps {
  reviews: ReadonlyArray<MemoryReviewItem>
  canReview: boolean
  selectedId: string | null
  result: MemoryReviewResult | null
  busy?: boolean
  onSelect: (proposalId: string) => void
  onReview: (proposalId: string, action: "approve" | "reject") => void
}

export function MemoryReview({
  reviews,
  canReview,
  selectedId,
  result,
  busy = false,
  onSelect,
  onReview
}: MemoryReviewProps) {
  const selected = reviews.find((review) => review.id === selectedId) ?? reviews[0] ?? null
  const [pageId, setPageId] = useState<string | null>(null)
  const selectedPage = selected?.pages.find((page) => page.pageId === pageId) ?? selected?.pages[0] ?? null

  return (
    <section className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]" aria-labelledby="memory-review-title">
      <div className="min-h-0 overflow-auto border-r border-hairline bg-panel">
        <div className="sticky top-0 border-b border-hairline bg-panel p-4">
          <h1 id="memory-review-title" className="m-0 text-lg font-semibold text-text-bright">Review inbox</h1>
          <p className="m-0 mt-1 text-[10.5px] text-muted-foreground">{reviews.filter((review) => review.status === "open").length} proposals awaiting review</p>
        </div>
        <ul className="m-0 list-none p-0" aria-label="Memory proposals">
          {reviews.map((review) => (
            <li key={review.id}><button type="button" onClick={() => { onSelect(review.id); setPageId(null) }} aria-pressed={selected?.id === review.id} className="flex w-full items-center gap-2 border-b border-hairline p-3 text-left outline-none hover:bg-surface/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-surface">
              <FileDiff size={14} className="text-blue" />
              <span className="min-w-0 flex-1"><strong className="block truncate text-[11.5px] text-text">{review.pages.length} page {review.pages.length === 1 ? "change" : "changes"}</strong><span className="mt-0.5 block truncate font-mono text-[9px] text-dim">{review.id} · {review.status}</span></span>
              <ChevronRight size={12} className="text-dim" />
            </button></li>
          ))}
        </ul>
      </div>

      {selected === null ? (
        <div className="m-auto text-[12px] text-muted-foreground">No proposals in this organization.</div>
      ) : (
        <div className="flex min-h-0 flex-col">
          <header className="flex flex-none items-center gap-3 border-b border-hairline px-4 py-3">
            <div className="min-w-0 flex-1"><strong className="block truncate text-[12px] text-text-bright">Proposal {selected.id}</strong><span className="text-[10px] text-muted-foreground">{selected.proposedBy} · {new Date(selected.createdAt).toLocaleString()} · {selected.changeKind}</span></div>
            {selected.status === "open" && canReview && <><button type="button" disabled={busy} onClick={() => onReview(selected.id, "reject")} className="flex items-center gap-1.5 rounded-md border border-line px-3 py-2 text-[11px] text-text outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><X size={13} /> Reject</button><button type="button" disabled={busy} onClick={() => onReview(selected.id, "approve")} className="flex items-center gap-1.5 rounded-md bg-blue px-3 py-2 text-[11px] font-semibold text-on-accent outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Check size={13} /> Accept all</button></>}
          </header>
          {result?.status === "conflict" && result.proposalId === selected.id && (
            <div role="alert" className="m-4 mb-0 flex items-start gap-2 rounded-lg border border-yellow/50 bg-sunken p-3 text-[11px] text-yellow"><AlertTriangle size={14} className="mt-0.5 flex-none" /><span><strong className="block">Publication conflict</strong>{result.conflicts.map((conflict) => `${conflict.pageId}: expected ${conflict.expectedBaseRevisionId}, current ${conflict.currentHeadRevisionId}`).join("; ")}</span></div>
          )}
          <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
            <div className="overflow-auto border-r border-hairline bg-sunken p-2" role="tablist" aria-label="Proposal pages">
              {selected.pages.map((page) => <button type="button" role="tab" aria-selected={selectedPage?.pageId === page.pageId} key={page.pageId} onClick={() => setPageId(page.pageId)} className="mb-1 w-full rounded-md p-2 text-left outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-surface"><strong className="block truncate text-[10.5px] text-text">{page.title}</strong><span className="mt-1 block truncate font-mono text-[8.5px] text-dim">base {page.baseRevisionId}</span></button>)}
            </div>
            <div className="min-h-0 overflow-auto p-4">
              {selectedPage && <><h2 className="m-0 text-base font-semibold text-text-bright">{selectedPage.title}</h2><p className="mt-1 text-[11px] text-muted-foreground">{selectedPage.summary}</p><pre className="mt-4 whitespace-pre-wrap rounded-lg border border-line bg-panel p-4 font-mono text-[10.5px] leading-5 text-text">{selectedPage.markdown}</pre></>}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
