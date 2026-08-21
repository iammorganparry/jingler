import type { ExplanationDocument } from "@jingler/core"
import { Sparkles } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../components/button.js"
import { PlanBlocks } from "../composites/plan-doc/plan-blocks.js"

export interface ExplanationViewProps {
  readonly document: ExplanationDocument | null
  readonly loading?: boolean
  readonly error?: string | null
  readonly onRetry?: () => void
}

/** Read-only focused visual artifact published by the agent. */
export function ExplanationView({
  document,
  loading = false,
  error = null,
  onRetry
}: ExplanationViewProps) {
  if (loading) return <Empty>Loading explanation…</Empty>
  if (error) {
    return (
      <Empty>
        <span>{error}</span>
        {onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
      </Empty>
    )
  }
  if (document === null) return <Empty>No explanation yet.</Empty>

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-editor">
      <article aria-label="Technical explanation" className="mx-auto flex w-full max-w-[820px] flex-col gap-5 px-4 py-8">
        <header className="flex flex-col gap-2 border-b border-hairline px-1 pb-5">
          <div className="flex items-center gap-2 text-blue">
            <Sparkles className="size-4" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.6px]">Explanation</span>
          </div>
          <h1 className="m-0 text-[20px] font-semibold leading-[1.3] text-text-bright">{document.title}</h1>
          <p className="m-0 max-w-[68ch] text-[13px] leading-[1.65] text-muted-foreground">{document.summary}</p>
        </header>
        {document.sections.map((section) => (
          <section key={section.id} aria-label={section.title} className="flex flex-col gap-2 rounded-lg border border-hairline bg-panel px-4 py-4">
            <h2 className="m-0 text-[14px] font-semibold text-text-bright">{section.title}</h2>
            <PlanBlocks blocks={section.blocks} className="sb-md text-[13px] leading-[1.7] text-text-body" />
          </section>
        ))}
      </article>
    </div>
  )
}

function Empty({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-editor px-4 text-center text-[13px] text-muted-foreground">
      <Sparkles className="size-8 text-line-strong" />
      {children}
    </div>
  )
}
