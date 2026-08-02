import { sanitizePlanHtml } from "@jingler/core"
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { MermaidDiagram } from "../../components/mermaid-diagram.js"
import { cn } from "../../lib/cn.js"
import {
  type PlanFileControls,
  PlanFileControlsProvider,
  type PlanFileEvidence
} from "./plan-file-controls.js"
import {
  type PlanWorkerControls,
  PlanWorkerControlsProvider
} from "./plan-worker-controls.js"

export type { PlanFileEvidence } from "./plan-file-controls.js"

/**
 * Read-only renderer for a plan HTML document.
 *
 * The whole plan — prose, stages, acceptance criteria, annotations, flow
 * diagrams — is the agent's canonical HTML. The operator no longer edits it in
 * place (their only mutation is commenting, layered on top separately); this
 * component sanitizes the source once and paints it into a styled container via
 * `dangerouslySetInnerHTML`, with token-driven styling targeting the plan
 * dialect's `data-*` selectors.
 *
 * Mermaid diagrams (`<div data-diagram="mermaid"><pre>…</pre></div>`) are the one
 * thing that needs real React: each is replaced by a live `MermaidDiagram` portal
 * (mermaid render is async) after the sanitized markup lands.
 *
 * `commentLayer` is the seam the comment layer plugs into; it renders as an
 * overlay above the document and is otherwise inert here.
 */
export interface PlanDocViewProps {
  /** Canonical plan source HTML; sanitized on every render. */
  readonly source: string
  readonly className?: string
  /** Live worktree diff stats keyed by repository-relative path. */
  readonly fileEvidence?: ReadonlyMap<string, PlanFileEvidence>
  /** Worktree paths the asset viewer can currently open. */
  readonly knownFiles?: ReadonlySet<string>
  readonly onOpenFile?: (path: string) => void
  /** Seam for stop/retry affordances a later stage re-attaches to worker nodes. */
  readonly workerControls?: PlanWorkerControls
  /** Seam for the comment layer: rendered as an overlay above the document. */
  readonly commentLayer?: ReactNode
}

interface DiagramPortal {
  readonly key: string
  readonly host: HTMLElement
  readonly source: string
}

export function PlanDocView({
  source,
  className,
  fileEvidence,
  knownFiles,
  onOpenFile,
  workerControls,
  commentLayer
}: PlanDocViewProps) {
  const html = useMemo(() => sanitizePlanHtml(source), [source])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [diagrams, setDiagrams] = useState<ReadonlyArray<DiagramPortal>>([])

  // Carve each mermaid block out of the sanitized markup and host a live portal
  // in its place. `dangerouslySetInnerHTML` only rewrites the DOM when `html`
  // itself changes, so the hosts we carve out here survive unrelated re-renders.
  useLayoutEffect(() => {
    const root = scrollRef.current
    if (root === null) return
    const portals: Array<DiagramPortal> = []
    root.querySelectorAll<HTMLElement>('[data-diagram="mermaid"]').forEach((element, index) => {
      const diagramSource = (element.querySelector("pre") ?? element).textContent?.trim() ?? ""
      element.replaceChildren()
      portals.push({ key: `diagram-${index}`, host: element, source: diagramSource })
    })
    setDiagrams(portals)
  }, [html])

  const fileControls: PlanFileControls = {
    evidence: fileEvidence,
    knownFiles,
    open: onOpenFile
  }

  return (
    <PlanWorkerControlsProvider controls={workerControls}>
      <PlanFileControlsProvider
        evidence={fileControls.evidence}
        knownFiles={fileControls.knownFiles}
        open={fileControls.open}
      >
        <div className={cn("relative flex min-h-0 flex-col", className)}>
          <div
            ref={scrollRef}
            role="document"
            aria-label="Plan document"
            className={cn(
              "min-h-0 flex-1 overflow-y-auto text-[13px] leading-[1.65] text-text-body",
              "[&_h1]:mb-3 [&_h1]:mt-1 [&_h1]:text-[22px] [&_h1]:font-semibold [&_h1]:leading-tight [&_h1]:text-text-bright",
              "[&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:border-b [&_h2]:border-line [&_h2]:pb-1 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:text-text-bright",
              "[&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:text-[12px] [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-[0.08em] [&_h3]:text-muted-foreground",
              "[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
              "[&_a]:text-blue [&_a]:underline [&_a]:underline-offset-2",
              "[&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px]",
              "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-surface [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[12px]",
              "[&_section[data-stage]]:my-5 [&_section[data-stage]]:rounded-lg [&_section[data-stage]]:border [&_section[data-stage]]:border-line [&_section[data-stage]]:bg-panel/40 [&_section[data-stage]]:p-4",
              "[&_[data-acceptance]]:my-1.5 [&_[data-acceptance]]:rounded-md [&_[data-acceptance]]:border [&_[data-acceptance]]:border-line [&_[data-acceptance]]:bg-panel [&_[data-acceptance]]:px-3 [&_[data-acceptance]]:py-2 [&_[data-acceptance]]:text-[12px]",
              "[&_[data-files]]:my-2.5 [&_[data-files]]:flex [&_[data-files]]:flex-wrap [&_[data-files]]:items-center [&_[data-files]]:gap-1.5 [&_[data-files]]:pl-0 [&_[data-files]>li]:my-0 [&_[data-files]>li]:list-none [&_[data-files]>li]:rounded [&_[data-files]>li]:border [&_[data-files]>li]:border-line [&_[data-files]>li]:bg-surface [&_[data-files]>li]:px-1.5 [&_[data-files]>li]:py-0.5 [&_[data-files]>li]:font-mono [&_[data-files]>li]:text-[11.5px]",
              "[&_[data-diagram]]:my-3 [&_[data-diagram]]:overflow-hidden [&_[data-diagram]]:rounded-md [&_[data-diagram]]:border [&_[data-diagram]]:border-line [&_[data-diagram]]:bg-editor [&_[data-diagram]]:px-3 [&_[data-diagram]]:py-2",
              "[&_aside[data-annotation]]:my-2 [&_aside[data-annotation]]:rounded-md [&_aside[data-annotation]]:border-l-2 [&_aside[data-annotation]]:border-line-strong [&_aside[data-annotation]]:bg-panel/60 [&_aside[data-annotation]]:px-3 [&_aside[data-annotation]]:py-2 [&_aside[data-annotation]]:text-[12px]"
            )}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: source is
            // re-sanitized by @jingler/core's sanitizePlanHtml on every render.
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {diagrams.map((diagram) =>
            createPortal(<MermaidDiagram source={diagram.source} />, diagram.host, diagram.key)
          )}
          {commentLayer}
        </div>
      </PlanFileControlsProvider>
    </PlanWorkerControlsProvider>
  )
}
