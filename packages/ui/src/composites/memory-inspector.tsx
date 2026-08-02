import type {
  MemoryEdgeEvidence,
  MemoryGraphNode,
  MemoryPageDetail
} from "@jingler/contracts"
import { ArrowLeft, BookOpen, ExternalLink, Link2, Quote, ShieldCheck, Users } from "lucide-react"

export interface MemoryInspectorProps {
  node: MemoryGraphNode | null
  evidence: MemoryEdgeEvidence | null
  page: MemoryPageDetail | null
  loading?: boolean
  pendingProposalCount?: number
  onBack: () => void
  onOpenPage: (pageId: string) => void
  onExpandNeighborhood: (nodeId: string) => void
}

export function MemoryInspector({
  node,
  evidence,
  page,
  loading = false,
  pendingProposalCount = 0,
  onBack,
  onOpenPage,
  onExpandNeighborhood
}: MemoryInspectorProps) {
  if (node === null && evidence === null) return null
  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[360px] flex-col border-l border-line bg-panel shadow-xl" aria-label="Memory inspector" data-testid="memory-inspector">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
        <button type="button" onClick={onBack} aria-label="Close inspector" className="rounded-md p-1.5 text-muted-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft size={14} /></button>
        <strong className="min-w-0 flex-1 truncate text-[12px] text-text-bright">{node?.title ?? `${evidence?.edge.kind} evidence`}</strong>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading && <p role="status" className="text-[11px] text-muted-foreground">Loading accepted detail…</p>}
        {evidence && (
          <section aria-labelledby="edge-evidence-title">
            <p className="m-0 text-[10px] font-semibold uppercase tracking-[0.1em] text-blue">Accepted relationship</p>
            <h2 id="edge-evidence-title" className="m-0 mt-1 text-lg font-semibold text-text-bright">{evidence.edge.kind}</h2>
            <dl className="mt-4 grid grid-cols-[80px_1fr] gap-x-3 gap-y-2 text-[11px]">
              <dt className="text-muted-foreground">From</dt><dd className="m-0 break-all font-mono text-text">{evidence.edge.sourceId}</dd>
              <dt className="text-muted-foreground">To</dt><dd className="m-0 break-all font-mono text-text">{evidence.edge.targetId}</dd>
              <dt className="text-muted-foreground">Location</dt><dd className="m-0 font-mono text-text">{evidence.evidence.path}{evidence.evidence.line ? `:${evidence.evidence.line}` : ""}</dd>
            </dl>
            <pre className="mt-4 whitespace-pre-wrap rounded-lg border border-line bg-sunken p-3 font-mono text-[10.5px] leading-5 text-text">{evidence.evidence.raw ?? evidence.evidence.label ?? evidence.evidence.target ?? "Structured frontmatter relationship"}</pre>
            <p className="mt-3 flex items-start gap-2 text-[10.5px] leading-4 text-muted-foreground"><ShieldCheck size={13} className="mt-0.5 flex-none text-green" />This edge resolves to accepted wiki evidence. Inferred and embedding-derived relationships are not displayed.</p>
          </section>
        )}
        {node && (
          <section aria-labelledby="node-inspector-title">
            <p className="m-0 font-mono text-[9.5px] text-dim">{node.id}</p>
            <h2 id="node-inspector-title" className="m-0 mt-1 text-lg font-semibold text-text-bright">{node.title}</h2>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[9.5px]"><span className="rounded border border-line px-2 py-1 text-text">{node.kind}</span><span className="rounded border border-line px-2 py-1 text-text">{node.freshness}</span><span className="rounded border border-line px-2 py-1 text-text">{node.degree.incoming + node.degree.outgoing} connections</span></div>
            <button type="button" onClick={() => onExpandNeighborhood(node.id)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-md border border-line bg-sunken px-3 py-2 text-[11px] font-medium text-text outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><Link2 size={13} /> Expand one-hop neighborhood</button>
          </section>
        )}
        {page && (
          <>
            <section className="mt-5 border-t border-hairline pt-4">
              <h3 className="m-0 flex items-center gap-2 text-[11px] font-semibold text-text-bright"><BookOpen size={13} /> Summary</h3>
              <p className="mt-2 line-clamp-5 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{page.page.body.slice(0, 600)}</p>
            </section>
            <section className="mt-4 border-t border-hairline pt-4">
              <h3 className="m-0 flex items-center gap-2 text-[11px] font-semibold text-text-bright"><Quote size={13} /> Citations ({page.page.citations.length})</h3>
              <ul className="m-0 mt-2 space-y-2 p-0 text-[10.5px] text-muted-foreground">{page.page.citations.map((citation) => <li key={citation.id} className="list-none rounded-md bg-sunken p-2"><span className="font-mono text-text">{citation.id}</span> · {citation.sourceId}{citation.locator ? ` · ${citation.locator}` : ""}</li>)}</ul>
            </section>
            <section className="mt-4 border-t border-hairline pt-4 text-[10.5px] text-muted-foreground">
              <h3 className="m-0 flex items-center gap-2 text-[11px] font-semibold text-text-bright"><Users size={13} /> Provenance and health</h3>
              <p>Revision {page.revision.revision} · {new Date(page.revision.acceptedAt).toLocaleDateString()} · {page.contributors.join(", ")}</p>
              <p>{page.backlinks.length} backlinks · {page.health.brokenLinks} broken links · {page.health.contradictions} contradictions · {pendingProposalCount} proposals</p>
            </section>
            <button type="button" onClick={() => onOpenPage(page.page.id)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-blue px-3 py-2 text-[11px] font-semibold text-on-accent outline-none focus-visible:ring-2 focus-visible:ring-ring"><ExternalLink size={13} /> Open page</button>
          </>
        )}
      </div>
    </aside>
  )
}
