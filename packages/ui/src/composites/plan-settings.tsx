import { useMemo, useState } from "react"
import { Schema } from "effect"
import { PlanPrd } from "@jingler/core"
import { RotateCcw, Save } from "lucide-react"
import { Button } from "../components/button.js"

export interface PlanSettingsProps {
  readonly source?: string | null
  readonly onSave?: (source: string) => Promise<void> | void
}

export const validatePlanTemplate = (source: string): ReadonlyArray<string> => {
  if (source.trim().length === 0) return []
  try {
    return Schema.decodeUnknownEither(PlanPrd)(JSON.parse(source))._tag === "Right"
      ? []
      : ["The plan template is not a valid structured plan."]
  } catch {
    return ["The plan template is not valid JSON."]
  }
}

const headingsOf = (source: string): ReadonlyArray<string> => {
  if (source.trim().length === 0) return []
  try {
    const decoded = Schema.decodeUnknownEither(PlanPrd)(JSON.parse(source))
    if (decoded._tag !== "Right") return []
    return [
      decoded.right.title,
      ...decoded.right.sections.map((section) => section.title),
      ...decoded.right.stages.map((stage) => stage.title)
    ]
  } catch {
    return []
  }
}

export function PlanSettings({ source, onSave }: PlanSettingsProps) {
  const persisted = source ?? ""
  const [draft, setDraft] = useState(persisted)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const diagnostics = useMemo(() => validatePlanTemplate(draft), [draft])
  const headings = useMemo(() => headingsOf(draft), [draft])

  const save = async () => {
    if (diagnostics.length > 0) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave?.(draft)
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save the plan template.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5">
      <header>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-purple">
          Enhanced planning
        </p>
        <h2 className="mt-1 text-[19px] font-semibold text-text-bright">PRD structure</h2>
        <p className="mt-1 max-w-[760px] text-[12px] leading-relaxed text-muted-foreground">
          This template defines Jingler&apos;s plan mode for every provider model. The selected
          agent owns progress, evidence, and revisions.
        </p>
      </header>

      <div className="grid min-h-0 gap-4 xl:grid-cols-2">
        <section className="flex min-h-[520px] flex-col overflow-hidden rounded-xl border border-line bg-sunken">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-[11px] font-medium text-text-bright">Template source</span>
            <span className="font-mono text-[10px] text-dim">
              {diagnostics.length === 0 ? "valid" : `${diagnostics.length} issue${diagnostics.length === 1 ? "" : "s"}`}
            </span>
          </div>
          <textarea
            aria-label="Plan template source"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[11.5px] leading-[1.65] text-text-body outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        </section>
        <section className="min-h-[520px] overflow-auto rounded-xl border border-line bg-editor p-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-dim">Live structure preview</p>
          {diagnostics.length > 0 ? (
            <ul className="mt-4 space-y-2 text-[12px] text-red">
              {diagnostics.map((diagnostic) => <li key={diagnostic}>{diagnostic}</li>)}
            </ul>
          ) : headings.length === 0 ? (
            <p className="mt-4 text-[12px] text-muted-foreground">Use the built-in enhanced plan structure.</p>
          ) : (
            <ol className="mt-4 space-y-2 text-[12px] text-text-body">
              {headings.map((heading, index) => <li key={`${index}:${heading}`}>{heading}</li>)}
            </ol>
          )}
        </section>
      </div>

      {saveError && <p role="alert" className="text-[11px] text-red">{saveError}</p>}
      <div className="flex items-center gap-2">
        <Button onClick={() => void save()} disabled={saving || diagnostics.length > 0 || draft === persisted}>
          <Save size={14} /> {saving ? "Saving…" : "Save template"}
        </Button>
        <Button variant="ghost" onClick={() => setDraft(persisted)} disabled={draft === persisted}>
          <RotateCcw size={14} /> Reset
        </Button>
      </div>
    </div>
  )
}
