import { type PlanPrd, sanitizePlanHtml, toPlanArchitectureView } from "@jingler/core"
import { useMemo } from "react"
import { MermaidDiagram } from "../components/mermaid-diagram.js"
import { cn } from "../lib/cn.js"

/**
 * The **Architecture** surface: a read-only render of a plan's prose sections
 * (Context / Goals / Technical design / Decisions) and every embedded mermaid
 * flow diagram.
 *
 * The component takes the canonical `PlanPrd` and derives its view with
 * `toPlanArchitectureView` — the pure `@jingler/core` projection that returns
 * the verbatim prose `sections` plus a flat, id-stamped `diagrams` list lifted
 * out of both the sections and the stages. Keeping the projection in core (not
 * here) means the same derivation is testable without React.
 *
 * ## Read-only
 *
 * There is no editor here — section bodies are the plan HTML dialect rendered
 * through `sanitizePlanHtml` into `dangerouslySetInnerHTML`, the same guarded
 * path the rest of the app uses for attacker-influenceable plan HTML. Diagrams
 * render through `MermaidDiagram` (strict mode, DOMPurify'd SVG).
 *
 * ## Why diagrams are stripped from the prose
 *
 * `toPlanArchitectureView` returns section `markdown` verbatim, so a section
 * that embeds a `<div data-diagram="mermaid">` still carries that block — and it
 * ALSO surfaces in `diagrams`. Rendering the section HTML as-is would therefore
 * print the raw mermaid source (as a `<pre>`) directly above the rendered
 * diagram. `sectionProse` removes the diagram blocks from the prose so each
 * diagram is drawn exactly once, in the dedicated diagrams region.
 */

/** Sanitize a section body and drop any embedded diagram blocks (rendered separately). */
const sectionProse = (markdown: string): string => {
  const html = sanitizePlanHtml(markdown)
  if (typeof DOMParser === "undefined") return html
  const doc = new DOMParser().parseFromString(html, "text/html")
  for (const el of doc.querySelectorAll("[data-diagram]")) el.remove()
  return doc.body.innerHTML.trim()
}

function ArchitectureSection({ title, markdown }: { title: string; markdown: string }) {
  const body = useMemo(() => sectionProse(markdown), [markdown])
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold text-text-bright">{title}</h2>
      <div
        className="sb-md text-[13px] leading-[1.65] text-text-body"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitizePlanHtml allowlist strips scripts/handlers/inline styles before render
        dangerouslySetInnerHTML={{ __html: body }}
      />
    </section>
  )
}

/**
 * Read-only Architecture view for a plan. Pass the canonical `PlanPrd`; the
 * component derives its own `PlanArchitectureView` via `toPlanArchitectureView`.
 */
export function PlanArchitecture({ prd, className }: { prd: PlanPrd; className?: string }) {
  const view = useMemo(() => toPlanArchitectureView(prd), [prd])
  const isEmpty = view.sections.length === 0 && view.diagrams.length === 0

  if (isEmpty) {
    return (
      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center px-4 py-10 text-center text-[13px] text-dim",
          className
        )}
      >
        No architecture notes yet
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-6 p-4", className)}>
      {view.sections.map((section) => (
        <ArchitectureSection key={section.id} title={section.title} markdown={section.markdown} />
      ))}

      {view.diagrams.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold text-text-bright">Diagrams</h2>
          <div className="flex flex-col gap-3">
            {view.diagrams.map((diagram) => (
              <div
                key={diagram.id}
                className="overflow-hidden rounded-md border border-line bg-panel px-3 py-2"
              >
                <MermaidDiagram source={diagram.source} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
