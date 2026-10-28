import type { ProjectRoutineTemplate, Project, Routine, RoutineDocument, RoutineInput } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { Button } from "../components/button.js"
import { Input } from "../components/input.js"
import { Checkbox } from "../components/checkbox.js"
import { SettingsCard, SettingsRow } from "../components/settings-row.js"
import { Toggle } from "../components/toggle.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import {
  modelKey,
  routineDraft,
  routineFormMachine,
  routinePayload,
  type RoutineModel,
} from "./routine-form-machine.js"

export interface RoutinesSettingsViewProps {
  templates?: ReadonlyArray<ProjectRoutineTemplate>
  template?: ProjectRoutineTemplate
  templateLoad?: number
  onTemplate?(template: ProjectRoutineTemplate): void
  projects: ReadonlyArray<Project>
  projectId: string
  models: RoutineModel[]
  document: RoutineDocument
  editing?: string
  busy: boolean
  loading: boolean
  error: string | null
  feedback?: string
  onEdit(id?: string): void
  onSave(id: string | undefined, input: RoutineInput): void
  onEnable(id: string, enabled: boolean): void
  onDelete(id: string): void
  onRun(id: string): void
  onCancel(id: string): void
  onOpen(id: string): void
  onRefresh(): void
}
const mutedText = "text-[12px] text-muted-foreground"

function RoutineRow({ routine, ...props }: RoutinesSettingsViewProps & { routine: Routine }) {
  const { busy, projectId } = props
  return (
    <SettingsRow
      label={routine.name}
      help={`Next: ${routine.enabled && routine.nextAt !== null ? new Date(routine.nextAt).toLocaleString() : "Not scheduled"}`}
      control={
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => props.onEdit(routine.id)}>
            Edit {routine.name}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => props.onEnable(routine.id, !routine.enabled)}>
            {routine.enabled ? "Disable" : "Enable"} {routine.name}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !routine.approved}
            onClick={() => {
              if (routine.approved && routine.projectId === projectId) props.onRun(routine.id)
            }}
          >
            Run now {routine.name}
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => props.onDelete(routine.id)}>
            Delete {routine.name}
          </Button>
        </div>
      }
    />
  )
}

function RunHistoryRow({ run, ...props }: RoutinesSettingsViewProps & { run: RoutineDocument["runs"][number] }) {
  const routine = props.document.routines.find((item) => item.id === run.routineId)
  const owner = routine
    ? (props.projects.find((item) => item.id === routine.projectId)?.name ?? "Project unavailable")
    : "Deleted routine"
  const sessionId = run.sessionId
  return (
    <SettingsRow
      label={`${run.routineName}: ${run.status}, ${run.message}`}
      help={owner}
      control={
        <div className="flex flex-wrap justify-end gap-2">
          {sessionId && (
            <Button size="sm" variant="outline" disabled={props.busy} onClick={() => props.onOpen(sessionId)}>
              Open workspace {run.routineName}
            </Button>
          )}
          {(run.status === "running" || run.status === "claimed") && (
            <Button size="sm" variant="danger" disabled={props.busy} onClick={() => props.onCancel(run.id)}>
              Cancel {run.routineName}
            </Button>
          )}
        </div>
      }
    />
  )
}

function SafetyNotes() {
  return (
    <>
      <p className={mutedText}>Safe mode: Ask permissions; edit and inspect only.</p>
      <details className={mutedText}>
        <summary className="cursor-pointer">Full routine safety details</summary>
        <p className="mt-2">
          Every run uses a fresh checkpoint-safe worktree. Edit and inspect files only. File rename is
          unsupported in safe mode; no files are changed. Arbitrary shell, tests, builds, terminals,
          delegation, offload and external tools are unsupported. Saved model, reasoning and Ask permissions
          are used without escalation or fallback.
        </p>
      </details>
    </>
  )
}

function TemplatesCard(props: RoutinesSettingsViewProps) {
  if (!props.projectId || (props.templates?.length ?? 0) === 0) return null
  return (
    <SettingsCard title="Shared routine templates">
      {props.templates?.map((template) => (
        <SettingsRow
          key={template.id}
          label={template.name}
          control={
            <Button size="sm" variant="outline" disabled={props.busy} onClick={() => props.onTemplate?.(template)}>
              Load template {template.name}
            </Button>
          }
        />
      ))}
    </SettingsCard>
  )
}

function SavedRoutinesCard(props: RoutinesSettingsViewProps & { routines: Routine[] }) {
  return (
    <SettingsCard title="Saved routines for this project">
      <p className={`${mutedText} px-4 py-3`}>Run now uses the saved, approved settings.</p>
      {!props.loading && props.routines.length === 0 && (
        <p className={`${mutedText} px-4 py-3`}>No saved routines for this project.</p>
      )}
      {props.routines.map((routine) => (
        <RoutineRow key={routine.id} routine={routine} {...props} />
      ))}
    </SettingsCard>
  )
}

function RunHistoryCard(props: RoutinesSettingsViewProps) {
  const runs = props.document.runs.slice().sort((a, b) => b.createdAt - a.createdAt)
  return (
    <SettingsCard title="All-project run history">
      <p className={`${mutedText} px-4 py-3`}>History includes every project and deleted routines.</p>
      {runs.length === 0 && <p className={`${mutedText} px-4 py-3`}>No routine runs yet.</p>}
      {runs.map((run) => (
        <RunHistoryRow key={run.id} run={run} {...props} />
      ))}
    </SettingsCard>
  )
}

export function RoutinesSettingsView(props: RoutinesSettingsViewProps) {
  const { projectId, document, editing, loading, error } = props
  const routines = document.routines.filter((item) => item.projectId === projectId)
  const selected = routines.find((item) => item.id === editing)
  return (
    <section
      aria-label="Saved desktop routines"
      className="space-y-4 border-t border-line pt-6 text-sm text-text-bright"
    >
      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold">Routines</h3>
          <Button size="sm" variant="outline" disabled={loading} onClick={props.onRefresh}>
            Refresh routines
          </Button>
        </div>
        <p className={`mt-1 ${mutedText}`}>
          Runs only while this desktop is open and signed in. Missed schedules and overlapping runs are
          skipped. One routine runs at a time; interactive agents remain independent.
        </p>
      </div>
      <SafetyNotes />
      {loading && (
        <p role="status" className={mutedText}>
          Loading routines…
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <Button size="sm" variant="outline" onClick={props.onRefresh}>
            Retry
          </Button>
        </p>
      )}
      <TemplatesCard {...props} />
      {projectId ? (
        <RoutineForm
          key={`${projectId}/${selected?.id ?? "new"}/${selected?.revision ?? ""}/${props.templateLoad ?? ""}`}
          {...props}
          selected={selected}
        />
      ) : (
        <p className={mutedText}>Add a local project to save a routine.</p>
      )}
      {props.feedback && (
        <p role="status" className={mutedText}>
          {props.feedback}
        </p>
      )}
      <SavedRoutinesCard {...props} routines={routines} />
      {document.health?.error && (
        <p role="alert">
          {document.health.error}. {document.health.recovery}.{" "}
          <Button size="sm" variant="outline" onClick={props.onRefresh}>
            Refresh history and health
          </Button>
        </p>
      )}
      <RunHistoryCard {...props} />
    </section>
  )
}
function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  disabled: boolean
  onChange(value: string): void
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm">{label}</p>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder="Choose an option" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
function RoutineForm({
  selected,
  template,
  models,
  projectId,
  busy,
  loading,
  onSave,
  onEdit,
}: RoutinesSettingsViewProps & { selected?: Routine }) {
  const [state, send] = useMachine(routineFormMachine, { input: { selected, models, template } })
  const { draft, approved, error } = state.context
  const edit = (patch: Partial<typeof draft>) => send({ type: "EDIT", patch })
  const disabled = busy || loading
  const unavailable = !models.some((model) => modelKey(model) === draft.model)
  return (
    <form
      aria-label="Save routine"
      className="space-y-4 rounded-lg border border-line p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || loading) return
        try {
          onSave(selected?.id, routinePayload(draft, approved, projectId, models, selected, template))
        } catch (error) {
          send({ type: "ERROR", message: error instanceof Error ? error.message : "Could not save routine." })
        }
      }}
    >
      <fieldset disabled={disabled} className="min-w-0 space-y-4">
        <legend className="mb-2 font-medium">{selected ? `Edit ${selected.name}` : "New routine"}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label htmlFor="routine-name">
            Name
            <Input
              id="routine-name"
              aria-label="Name"
              maxLength={120}
              value={draft.name}
              onChange={(event) => edit({ name: event.currentTarget.value })}
            />
          </label>
          <label htmlFor="routine-branch">
            Base branch
            <Input
              id="routine-branch"
              aria-label="Base branch"
              value={draft.branch}
              onChange={(event) => edit({ branch: event.currentTarget.value })}
            />
          </label>
        </div>
        <Choice
          label="Managed Pi model"
          value={draft.model}
          disabled={disabled}
          onChange={(model) => edit({ model })}
          options={[
            ...(unavailable && draft.model
              ? [
                  {
                    value: draft.model,
                    label: `Unavailable saved model: ${selected?.modelId ?? draft.model}`,
                  },
                ]
              : []),
            ...models.map((model) => ({
              value: modelKey(model),
              label: `${model.connection.providerId} · ${model.id}`,
            })),
          ]}
        />
        {unavailable && (
          <p role="status" className="text-dim">
            {models.length === 0
              ? "No available managed Pi models. Configure a desktop provider first."
              : "Choose an available local model explicitly and approve these settings."}
          </p>
        )}
        <Choice
          label="Reasoning"
          value={draft.reasoning}
          disabled={disabled}
          onChange={(reasoning) => edit({ reasoning })}
          options={[
            { value: "default", label: "Provider default" },
            { value: "off", label: "Off" },
            { value: "on", label: "On (provider effort)" },
            ...["minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })),
          ]}
        />
        <p className="text-xs text-dim">Permissions: Ask. No automatic escalation.</p>
        <label className="block">
          Prompt
          <textarea
            aria-label="Prompt"
            className="mt-1 min-h-24 w-full rounded-md border border-line bg-sunken p-2 text-text-bright"
            value={draft.prompt}
            onChange={(event) => edit({ prompt: event.currentTarget.value })}
          />
        </label>
        <Choice
          label="Schedule"
          value={draft.schedule}
          disabled={disabled}
          onChange={(schedule) => edit({ schedule })}
          options={[
            { value: "once", label: "Once" },
            { value: "interval", label: "Fixed interval" },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <label htmlFor="routine-at">
            First occurrence
            <Input
              id="routine-at"
              aria-label="First occurrence"
              type="datetime-local"
              step={1}
              value={draft.at}
              onChange={(event) => edit({ at: event.currentTarget.value })}
            />
          </label>
          {draft.schedule === "interval" && (
            <label htmlFor="routine-interval">
              Interval minutes
              <Input
                id="routine-interval"
                aria-label="Interval minutes"
                type="number"
                min={1 / 60}
                step="any"
                max={525600}
                value={draft.interval}
                onChange={(event) => edit({ interval: event.currentTarget.value })}
              />
            </label>
          )}
          <label htmlFor="routine-duration">
            Maximum run minutes
            <Input
              id="routine-duration"
              aria-label="Maximum run minutes"
              type="number"
              min={1 / 60}
                step="any"
              max={1440}
              value={draft.duration}
              onChange={(event) => edit({ duration: event.currentTarget.value })}
            />
          </label>
        </div>
        <Toggle
          id="routine-enabled"
          label="Enable schedule"
          checked={draft.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => edit({ enabled })}
        />
      </fieldset>
      <Checkbox
        id="routine-approved"
        disabled={disabled}
        checked={approved}
        onCheckedChange={(approved) => send({ type: "APPROVE", approved })}
        label="I approve these exact settings and the edit/inspect-only restrictions for Save and Run now."
      />
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={disabled}>
          {busy ? "Saving…" : "Save routine"}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            send({ type: "RESET", draft: routineDraft({ models }) })
            onEdit()
          }}
        >
          New routine
        </Button>
      </div>
    </form>
  )
}
