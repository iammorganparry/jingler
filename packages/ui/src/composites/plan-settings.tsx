import { DEFAULT_PLAN_TEMPLATE, parsePlanMdx } from "@jingler/core"
import { RotateCcw, Save } from "lucide-react"
import { useMemo, useState } from "react"
import { Button } from "../components/button.js"

export interface PlanSettingsProps {
  readonly source?: string | null
  readonly onSave?: (source: string) => Promise<void> | void
}

export const validatePlanTemplate = (source: string): ReadonlyArray<string> => {
  const result = parsePlanMdx(source)
  return result.valid ? [] : result.diagnostics.map((diagnostic) => diagnostic.message)
}

const headingsOf = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/^#{1,2}\s+(.+)$/gm)].map((match) => match[1]!.trim())

export function PlanSettings({ source, onSave }: PlanSettingsProps) {
  const persisted = source ?? DEFAULT_PLAN_TEMPLATE
  const [draft, setDraft] = useState(persisted)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const diagnostics = useMemo(() => validatePlanTemplate(draft), [draft])
  const headings = useMemo(() => headingsOf(draft), [draft])
  const dirty = draft !== persisted

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5">
      <header>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-purple">
          Native planning
        </p>
        <h2 className="mt-1 text-[19px] font-semibold text-text-bright">PRD structure</h2>
        <p className="mt-1 max-w-[760px] text-[12px] leading-relaxed text-muted-foreground">
          This MDX template is injected into every plan-mode turn. Markdown carries prose;
          Stage, Acceptance, and Annotation are the only interactive components.
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
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[11.5px] leading-[1.65] text-text-body outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        </section>

        <section className="min-h-[520px] overflow-auto rounded-xl border border-line bg-editor p-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-dim">
            Live structure preview
          </p>
          {diagnostics.length > 0 ? (
            <div className="mt-4 rounded-lg border border-yellow/35 bg-yellow/5 p-3" role="alert">
              <p className="text-[11px] font-medium text-yellow">Fix before saving</p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-text-body">
                {diagnostics.map((diagnostic) => <li key={diagnostic}>{diagnostic}</li>)}
              </ul>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {headings.map((heading, index) => (
                <div
                  key={`${heading}-${index}`}
                  className="rounded-lg border border-line bg-surface px-3 py-2 text-[11.5px] text-text-body"
                >
                  {heading}
                </div>
              ))}
              <div className="rounded-lg border border-purple/30 bg-purple/5 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-purple">
                  Interactive stage
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Acceptance criteria become status controls and evidence fields in Plan Review.
                </p>
              </div>
            </div>
          )}
          {saveError !== null && (
            <div className="mt-4 rounded-lg border border-red/35 bg-red/5 p-3" role="alert">
              <p className="text-[11px] font-medium text-red">Template was not saved</p>
              <p className="mt-1 whitespace-pre-wrap text-[11px] text-text-body">{saveError}</p>
            </div>
          )}
        </section>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDraft(DEFAULT_PLAN_TEMPLATE)}
          disabled={draft === DEFAULT_PLAN_TEMPLATE}
        >
          <RotateCcw size={13} />
          Reset default
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setSaving(true)
            setSaveError(null)
            void Promise.resolve()
              .then(() => onSave?.(draft))
              .catch((error: unknown) =>
                setSaveError(error instanceof Error ? error.message : String(error))
              )
              .finally(() => setSaving(false))
          }}
          disabled={!dirty || diagnostics.length > 0 || saving}
        >
          <Save size={13} />
          {saving ? "Saving…" : "Save template"}
        </Button>
      </div>
    </div>
  )
}
