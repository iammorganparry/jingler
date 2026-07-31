import type {
  CliInfo,
  CliKind,
  ModelOption,
  OrchestratorPreference,
  ProvidersConfig,
  ReasoningEffort,
  WorkerModelRoute,
  WorkerRoutingConfig
} from "@jingler/core"
import {
  DEFAULT_PLAN_TEMPLATE_HTML,
  defaultModel,
  parsePlanHtml,
  providerReasoningCapabilitiesFor,
  resolveOrchestratorPreference,
  resolveWorkerRoutingConfig,
  supportsPlanMode,
  workerReasoningSettingIssue
} from "@jingler/core"
import { RotateCcw, Save } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Button } from "../components/button.js"
import { PROVIDER_LABEL, ProviderIcon } from "../components/provider-icon.js"
import { reasoningEffortsFor } from "../lib/reasoning-options.js"
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
  readonly providers?: ProvidersConfig | null
  readonly loadModels?: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  readonly onSaveOrchestrator?: (
    orchestrator: OrchestratorPreference
  ) => Promise<void> | void
  readonly workerRouting?: WorkerRoutingConfig | null
  readonly onSaveWorkerRouting?: (
    routing: WorkerRoutingConfig
  ) => Promise<void> | void
}

const ROUTING_BUCKETS = [
  {
    key: "default",
    label: "Default",
    description: "Fallback when a bucket or selected model is unavailable."
  },
  {
    key: "low",
    label: "Low complexity",
    description: "Small, well-scoped implementation and release tasks."
  },
  {
    key: "medium",
    label: "Medium complexity",
    description: "Ordinary feature work with several moving parts."
  },
  {
    key: "high",
    label: "High complexity",
    description: "Architecture, risky changes, and difficult debugging."
  }
] as const

type WorkerReasoningChoice =
  | "provider-default"
  | "off"
  | "on"
  | ReasoningEffort

const workerReasoningChoice = (
  route: WorkerModelRoute
): WorkerReasoningChoice =>
  route.reasoning === undefined
    ? "provider-default"
    : route.reasoning.enabled === false
      ? "off"
      : (route.reasoning.effort ?? "on")

export const workerReasoningOptionsFor = (
  cli: CliKind
): ReadonlyArray<{ readonly value: WorkerReasoningChoice; readonly label: string }> => {
  const capabilities = providerReasoningCapabilitiesFor(cli)
  if (!capabilities.explicitToggle) {
    return [{ value: "provider-default", label: "Provider default" }]
  }
  return [
    { value: "provider-default", label: "Provider default" },
    { value: "off", label: "Thinking off" },
    { value: "on", label: "Thinking on · provider default effort" },
    ...reasoningEffortsFor(cli).map((effort) => ({
      value: effort,
      label: effort
    }))
  ]
}

const routeWithReasoning = (
  route: WorkerModelRoute,
  choice: WorkerReasoningChoice
): WorkerModelRoute =>
  choice === "provider-default"
    ? { cli: route.cli, model: route.model }
    : {
        cli: route.cli,
        model: route.model,
        reasoning:
          choice === "off"
            ? { enabled: false }
            : choice === "on"
              ? { enabled: true }
              : { enabled: true, effort: choice }
      }

const workerRoutesEqual = (
  left: WorkerModelRoute,
  right: WorkerModelRoute
): boolean =>
  left.cli === right.cli &&
  left.model === right.model &&
  left.reasoning?.enabled === right.reasoning?.enabled &&
  left.reasoning?.effort === right.reasoning?.effort

function WorkerRoutingSettings({
  clis,
  routing,
  loadModels,
  onSave
}: {
  clis: ReadonlyArray<CliInfo>
  routing?: WorkerRoutingConfig | null
  loadModels?: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  onSave?: (routing: WorkerRoutingConfig) => Promise<void> | void
}) {
  const planning = useMemo(
    () => clis.filter((cli) => cli.available && supportsPlanMode(cli.kind)),
    [clis]
  )
  const [catalog, setCatalog] = useState<
    ReadonlyArray<{
      readonly cli: CliKind
      readonly models: ReadonlyArray<ModelOption>
    }>
  >([])

  useEffect(() => {
    let live = true
    if (loadModels === undefined) {
      setCatalog(
        planning.map((cli) => ({
          cli: cli.kind,
          models: [
            { id: defaultModel(cli.kind), label: defaultModel(cli.kind) }
          ]
        }))
      )
      return () => {
        live = false
      }
    }
    void Promise.all(
      planning.map(async (cli) => ({
        cli: cli.kind,
        models: await loadModels(cli.kind).catch(() => [])
      }))
    ).then((next) => {
      if (live) setCatalog(next)
    })
    return () => {
      live = false
    }
  }, [loadModels, planning])

  const effective = resolveWorkerRoutingConfig(routing, catalog)
  if (effective === null) return null

  const saveRoute = (
    key: (typeof ROUTING_BUCKETS)[number]["key"],
    route: WorkerModelRoute
  ) => {
    void onSave?.({ ...effective, [key]: route })
  }
  const fallbackBuckets =
    routing === null || routing === undefined
      ? []
      : ROUTING_BUCKETS.filter(
          ({ key }) =>
            !workerRoutesEqual(routing[key], effective[key])
        )

  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <div>
        <h2 className="text-[14px] font-semibold text-text-bright">
          Worker model routing
        </h2>
        <p className="mt-1 max-w-[760px] text-[11.5px] leading-relaxed text-muted-foreground">
          Jingler routes each dependency/file component by its strongest stage
          complexity. These concrete worker routes are independent of the
          orchestrator model.
        </p>
      </div>
      <div className="mt-4 divide-y divide-line rounded-lg border border-line">
        {ROUTING_BUCKETS.map(({ key, label, description }) => {
          const route = effective[key]
          const models =
            catalog.find((provider) => provider.cli === route.cli)?.models ?? []
          return (
            <div
              className="grid gap-3 p-3 md:grid-cols-[minmax(150px,1fr)_minmax(140px,0.9fr)_minmax(170px,1.1fr)_minmax(150px,0.9fr)] md:items-center"
              key={key}
            >
              <div>
                <p className="text-[11.5px] font-medium text-text-bright">
                  {label}
                </p>
                <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
                  {description}
                </p>
              </div>
              <Select
                value={route.cli}
                onValueChange={(value) => {
                  const cli = value as CliKind
                  const first =
                    catalog.find((provider) => provider.cli === cli)?.models[0]
                  const next = {
                    cli,
                    model: first?.id ?? defaultModel(cli)
                  } satisfies WorkerModelRoute
                  saveRoute(
                    key,
                    workerReasoningSettingIssue(cli, route.reasoning) === null &&
                      route.reasoning !== undefined
                      ? { ...next, reasoning: route.reasoning }
                      : next
                  )
                }}
              >
                <SelectTrigger aria-label={`${label} worker harness`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalog.map((provider) => (
                    <SelectItem key={provider.cli} value={provider.cli}>
                      {PROVIDER_LABEL[provider.cli]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={route.model}
                onValueChange={(model) =>
                  saveRoute(key, { ...route, model })
                }
              >
                <SelectTrigger aria-label={`${label} worker model`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(models.length > 0
                    ? models
                    : [{ id: route.model, label: route.model }]
                  ).map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={workerReasoningChoice(route)}
                onValueChange={(choice) =>
                  saveRoute(
                    key,
                    routeWithReasoning(route, choice as WorkerReasoningChoice)
                  )
                }
              >
                <SelectTrigger aria-label={`${label} worker reasoning`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {workerReasoningOptionsFor(route.cli).map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        })}
      </div>
      {routing === null || routing === undefined ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Sensible default: every bucket uses the first available
          planning-capable route until you customize it.
        </p>
      ) : fallbackBuckets.length > 0 ? (
        <p className="mt-3 rounded-md border border-yellow/35 bg-yellow/5 px-3 py-2 text-[11px] text-yellow">
          Unavailable saved routes are using the configured default:{" "}
          {fallbackBuckets.map((bucket) => bucket.label).join(", ")}.
        </p>
      ) : null}
    </section>
  )
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
  orchestrator: OrchestratorPreference | null | undefined,
  catalog: ReadonlyArray<{
    readonly cli: CliKind
    readonly models: ReadonlyArray<ModelOption>
  }> = clis
    .filter((cli) => cli.available && supportsPlanMode(cli.kind))
    .map((cli) => ({
      cli: cli.kind,
      models: [
        { id: defaultModel(cli.kind), label: defaultModel(cli.kind) }
      ]
    })),
  providers?: ProvidersConfig | null
): OrchestratorPreference | null => {
  const config = {
    ...(orchestrator === null || orchestrator === undefined
      ? {}
      : { orchestrator }),
    ...(providers === null || providers === undefined ? {} : { providers })
  }
  return resolveOrchestratorPreference(config, catalog)?.preference ?? null
}

function OrchestratorSettings({
  clis,
  orchestrator,
  providers,
  loadModels,
  onSave
}: {
  clis: ReadonlyArray<CliInfo>
  orchestrator?: OrchestratorPreference | null
  providers?: ProvidersConfig | null
  loadModels?: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  onSave?: (orchestrator: OrchestratorPreference) => Promise<void> | void
}) {
  type ModelCatalog = ReadonlyArray<{
    readonly cli: CliKind
    readonly models: ReadonlyArray<ModelOption>
  }>
  const planning = useMemo(
    () => clis.filter((cli) => cli.available && supportsPlanMode(cli.kind)),
    [clis]
  )
  const fallbackCatalog = useMemo<ModelCatalog>(
    () =>
      planning.map((cli) => ({
        cli: cli.kind,
        models: [
          { id: defaultModel(cli.kind), label: defaultModel(cli.kind) }
        ]
      })),
    [planning]
  )
  const [catalog, setCatalog] = useState<ModelCatalog>(fallbackCatalog)
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  useEffect(() => {
    let live = true
    setCatalog(fallbackCatalog)
    setCatalogLoaded(false)
    if (loadModels === undefined) {
      return () => {
        live = false
      }
    }
    void Promise.all(
      planning.map(async (cli) => ({
        cli: cli.kind,
        models: await loadModels(cli.kind).catch(() => [])
      }))
    ).then((next) => {
      if (live) {
        setCatalog(next)
        setCatalogLoaded(true)
      }
    })
    return () => {
      live = false
    }
  }, [fallbackCatalog, loadModels, planning])

  const effective = resolveEffectiveOrchestrator(
    clis,
    orchestrator,
    catalog,
    providers
  )
  const [selectedCli, setSelectedCli] = useState<CliKind | null>(effective?.cli ?? null)
  const selected = planning.find((cli) => cli.kind === selectedCli) ?? planning[0]
  const models =
    catalog.find((provider) => provider.cli === selected?.kind)?.models ?? []
  const harnessFallback =
    orchestrator !== null &&
    orchestrator !== undefined &&
    effective !== null &&
    effective.cli !== orchestrator.cli

  useEffect(() => {
    setSelectedCli(effective?.cli ?? null)
  }, [effective?.cli])

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
    selected.kind === effective.cli &&
    models.some((model) => model.id === effective.model)
      ? effective.model
      : models[0]?.id ?? defaultModel(selected.kind)
  const modelFallback =
    !harnessFallback &&
    catalogLoaded &&
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
            const model =
              catalog.find((provider) => provider.cli === cli)?.models[0]?.id ??
              defaultModel(cli)
            void onSave?.({ cli, model })
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
  providers,
  loadModels,
  onSaveOrchestrator,
  workerRouting,
  onSaveWorkerRouting
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
        providers={providers}
        loadModels={loadModels}
        onSave={onSaveOrchestrator}
      />
      <WorkerRoutingSettings
        clis={clis}
        routing={workerRouting}
        loadModels={loadModels}
        onSave={onSaveWorkerRouting}
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
