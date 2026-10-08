import type { ExplanationDocument } from "@jingler/core"
import { Sparkles } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../components/button.js"
import { VisualBlocks } from "../composites/visual-blocks.js"

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
      <article aria-label="Technical explanation" className="sb-plan mx-auto flex w-full max-w-[760px] flex-col px-8 py-10">
        <header className="border-b border-line pb-8">
          <p className="m-0 flex items-center gap-2 font-mono text-[12px] uppercase tracking-wide text-blue">
            <Sparkles className="size-3.5" /> Explanation
          </p>
          <h1 className="sb-plan-doc-title mt-2">{document.title}</h1>
          <p className="sb-plan-lead mt-3 text-muted-foreground">{document.summary}</p>
        </header>
        {document.sections.map((section) => (
          <section key={section.id} aria-label={section.title} className="mt-10">
            <h2 className="sb-plan-heading">{section.title}</h2>
            <VisualBlocks blocks={section.blocks} />
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
