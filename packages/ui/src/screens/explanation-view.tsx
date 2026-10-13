import type { ExplanationDocument } from "@jingler/core"
import { Sparkles } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../components/button.js"
import { EmptyState, InlineError, ListSkeleton } from "../components/feedback.js"
import { Skeleton } from "../components/loading.js"
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
  if (loading) return <ExplanationSkeleton />
  if (error) {
    return (
      <Centered>
        <InlineError message={error} onRetry={onRetry} className="max-w-md" />
      </Centered>
    )
  }
  if (document === null) {
    return (
      <Centered>
        <EmptyState
          icon={<Sparkles className="size-8" />}
          title="No explanation yet."
          description="Ask the agent to explain how something works and it will publish a visual explanation here."
        />
      </Centered>
    )
  }

  return <ExplanationArticle document={document} />
}

const jumpToSection = (id: string): void => {
  globalThis.document.getElementById(`explanation-section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
}

/** Sticky contents rail; hidden below 1000px of container width. */
function ExplanationContents({ sections }: { readonly sections: ExplanationDocument["sections"] }) {
  if (sections.length < 2) return null
  return (
    <nav aria-label="Explanation contents" className="sticky top-10 hidden max-h-[calc(100vh-120px)] w-52 flex-none self-start overflow-y-auto @min-[1000px]:block">
      <p className="m-0 mb-2 px-2 font-mono text-[11px] uppercase tracking-wide text-dim">Contents</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {sections.map((section) => (
          <li key={section.id}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => jumpToSection(section.id)}
              className="h-auto w-full justify-start whitespace-normal px-2 py-1 text-left text-[13px] font-normal leading-snug"
            >
              {section.title}
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function ExplanationArticle({ document }: { readonly document: ExplanationDocument }) {
  return (
    <div className="@container min-h-0 min-w-0 flex-1 overflow-auto bg-editor">
      <div className="mx-auto flex max-w-[1120px] gap-10 px-8 py-10">
        <ExplanationContents sections={document.sections} />
        <article aria-label="Technical explanation" className="sb-plan flex min-w-0 max-w-[760px] flex-1 flex-col">
          <header className="border-b border-hairline pb-8">
            <p className="m-0 flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.06em] text-dim">
              <Sparkles className="size-3.5" /> Explanation
            </p>
            <h1 className="sb-plan-doc-title mt-2">{document.title}</h1>
            <p className="sb-plan-lead mt-3 text-muted-foreground">{document.summary}</p>
          </header>
          {document.sections.map((section) => (
            <section key={section.id} id={`explanation-section-${section.id}`} aria-label={section.title} className="mt-10">
              <h2 className="sb-plan-heading">{section.title}</h2>
              <VisualBlocks blocks={section.blocks} />
            </section>
          ))}
        </article>
      </div>
    </div>
  )
}

function Centered({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-editor px-4">{children}</div>
}

/** Skeleton shaped like the loaded article: title, lead, then heading + paragraph groups. */
function ExplanationSkeleton() {
  return (
    <div aria-busy="true" className="@container min-h-0 min-w-0 flex-1 overflow-auto bg-editor">
      <span className="sr-only">Loading explanation…</span>
      <div className="mx-auto flex max-w-[1120px] gap-10 px-8 py-10">
        <div className="hidden w-52 flex-none @min-[1000px]:block">
          <ListSkeleton rows={5} rowHeight={24} gap={8} />
        </div>
        <div className="flex min-w-0 max-w-[760px] flex-1 flex-col gap-10">
          <div className="flex flex-col gap-3 border-b border-hairline pb-8">
            <Skeleton className="h-6 w-2/3" />
            <ListSkeleton rows={2} rowHeight={16} gap={8} />
          </div>
          {[0, 1, 2].map((group) => (
            <div key={group} className="flex flex-col gap-4">
              <Skeleton className="h-6 w-1/3" />
              <ListSkeleton rows={3} rowHeight={16} gap={10} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
