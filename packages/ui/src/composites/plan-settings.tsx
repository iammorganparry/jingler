import type {
  CliInfo,
  CliKind,
  ModelOption,
  OrchestratorPreference
} from "@jingler/core"
import {
  DEFAULT_PLAN_TEMPLATE_HTML,
  defaultModel,
  parsePlanHtml,
  supportsPlanMode
} from "@jingler/core"
import { RotateCcw, Save } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Button } from "../components/button.js"
import { PROVIDER_LABEL, ProviderIcon } from "../components/provider-icon.js"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/select.js"

export interface PlanSettingsProps {
  readonly source?: string | null
  readonly onSave?: (source: string) => Promise<void> | void
  readonly clis?: ReadonlyArray<CliInfo>
  readonly orchestrator?: OrchestratorPreference | null
  readonly loadModels?: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  readonly onSaveOrchestrator?: (
    orchestrator: OrchestratorPreference
  ) => Promise<void> | void
}

export const validatePlanTemplate = (source: string): ReadonlyArray<string> => {
  const result = parsePlanHtml(source)
  return result.valid ? [] : result.diagnostics.map((diagnostic) => diagnostic.message)
}

const headingsOf = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].map((match) =>
    match[1]!.replace(/<[^>]+>/g, "").trim()
  )

export const resolveEffectiveOrchestrator = (
  clis: ReadonlyArray<CliInfo>,
  orchestrator: OrchestratorPreference | null | undefined
): OrchestratorPreference | null => {
  const planning = clis.filter((cli) => cli.available && supportsPlanMode(cli.kind))
  const configured = planning.find((cli) => cli.kind === orchestrator?.cli)
  if (configured !== undefined && orchestrator !== null && orchestrator !== undefined) {
    return orchestrator
  }
  const fallback = planning[0]
  return fallback === undefined
    ? null
    : { cli: fallback.kind, model: defaultModel(fallback.kind) }
}

function OrchestratorSettings({
  clis,
  orchestrator,
  loadModels,
  onSave
}: {
  clis: ReadonlyArray<CliInfo>
  orchestrator?: OrchestratorPreference | null
  loadModels?: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  onSave?: (orchestrator: OrchestratorPreference) => Promise<void> | void
}) {
  const effective = resolveEffectiveOrchestrator(clis, orchestrator)
  const planning = clis.filter((cli) => cli.available && supportsPlanMode(cli.kind))
  const [selectedCli, setSelectedCli] = useState<CliKind | null>(effective?.cli ?? null)
  const [models, setModels] = useState<ReadonlyArray<ModelOption>>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const selected = planning.find((cli) => cli.kind === selectedCli) ?? planning[0]
  const harnessFallback =
    orchestrator !== null &&
    orchestrator !== undefined &&
    effective !== null &&
    effective.cli !== orchestrator.cli

  useEffect(() => {
    setSelectedCli(effective?.cli ?? null)
  }, [effective?.cli])

  useEffect(() => {
    if (selected === undefined || loadModels === undefined) {
      setModels([])
      setModelsLoaded(false)
      return
    }
    setModelsLoaded(false)
    let live = true
    void loadModels(selected.kind)
      .then((options) => {
        if (live) {
          setModels(options)
          setModelsLoaded(true)
        }
      })
      .catch(() => {
        if (live) {
          setModels([])
          setModelsLoaded(true)
        }
      })
    return () => {
      live = false
    }
  }, [selected, loadModels])

  if (effective === null || selected === undefined) {
    return (
      <section className="rounded-xl border border-yellow/35 bg-yellow/5 p-4">
        <p className="text-[12px] font-medium text-yellow">No planning provider is available</p>
        <p className="mt-1 text-[11.5px] text-text-body">
          Install Claude Code, Codex, or OpenCode before starting an orchestrated session.
        </p>
      </section>
    )
  }

  const selectedModel =
    selected.kind === orchestrator?.cli &&
    models.some((model) => model.id === orchestrator.model)
      ? orchestrator.model
      : models[0]?.id ?? defaultModel(selected.kind)
  const modelFallback =
    !harnessFallback &&
    modelsLoaded &&
    selected.kind === orchestrator?.cli &&
    !models.some((model) => model.id === orchestrator.model)

  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 flex-none place-items-center rounded-lg bg-surface">
          <ProviderIcon cli={selected.kind} size={18} />
        </span>
        <div>
          <h2 className="text-[14px] font-semibold text-text-bright">Preferred orchestrator</h2>
          <p className="mt-1 max-w-[720px] text-[11.5px] leading-relaxed text-muted-foreground">
            New sessions use this model to inspect the repository, author the plan, assign
            worker agents, and reconcile progress. Worker stages may use different models.
          </p>
        </div>
      </div>
      <div className="mt-4 grid max-w-[620px] gap-3 sm:grid-cols-2">
        <Select
          value={selected.kind}
          onValueChange={(value) => {
            const cli = value as CliKind
            setSelectedCli(cli)
            void onSave?.({ cli, model: defaultModel(cli) })
          }}
        >
          <SelectTrigger aria-label="Orchestrator harness">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {planning.map((cli) => (
              <SelectItem key={cli.kind} value={cli.kind}>
                {PROVIDER_LABEL[cli.kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={selectedModel}
          onValueChange={(model) => void onSave?.({ cli: selected.kind, model })}
        >
          <SelectTrigger aria-label="Orchestrator model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(models.length > 0
              ? models
              : [{ id: selectedModel, label: selectedModel }]
            ).map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {(harnessFallback || modelFallback) && (
        <p className="mt-3 rounded-md border border-yellow/35 bg-yellow/5 px-3 py-2 text-[11px] text-yellow">
          {harnessFallback ? (
            <>
              {PROVIDER_LABEL[orchestrator.cli]} is unavailable. New sessions will use{" "}
              {PROVIDER_LABEL[effective.cli]} until the configured provider returns.
            </>
          ) : (
            <>
              {PROVIDER_LABEL[selected.kind]} model {orchestrator?.model} is unavailable.
              New sessions will use {PROVIDER_LABEL[selected.kind]} model {selectedModel}.
            </>
          )}
        </p>
      )}
    </section>
  )
}

export function PlanSettings({
  source,
  onSave,
  clis = [],
  orchestrator,
  loadModels,
  onSaveOrchestrator
}: PlanSettingsProps) {
  const persisted = source ?? DEFAULT_PLAN_TEMPLATE_HTML
  const [draft, setDraft] = useState(persisted)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const diagnostics = useMemo(() => validatePlanTemplate(draft), [draft])
  const headings = useMemo(() => headingsOf(draft), [draft])
  const dirty = draft !== persisted

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5">
      <OrchestratorSettings
        clis={clis}
        orchestrator={orchestrator}
        loadModels={loadModels}
        onSave={onSaveOrchestrator}
      />
      <header>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-purple">
          Native planning
        </p>
        <h2 className="mt-1 text-[19px] font-semibold text-text-bright">PRD structure</h2>
        <p className="mt-1 max-w-[760px] text-[12px] leading-relaxed text-muted-foreground">
          This HTML template is injected into every plan-mode turn. Prose is ordinary HTML;
          stages, acceptance criteria, annotations, and flow diagrams are carried on
          data-attributes and become interactive widgets in Plan Review.
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
          onClick={() => setDraft(DEFAULT_PLAN_TEMPLATE_HTML)}
          disabled={draft === DEFAULT_PLAN_TEMPLATE_HTML}
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
