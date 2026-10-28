import { useEffect, useState, type ReactNode } from "react"
import type { Project, ProjectConfig, ProjectRoutineTemplate } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { Button } from "../components/button.js"
import { Checkbox } from "../components/checkbox.js"
import { Input } from "../components/input.js"
import { FolderX } from "lucide-react"
import type { SnapshotFrom } from "xstate"
import { ConfirmDialog } from "../components/confirm-dialog.js"
import { SettingsCard, SettingsRow } from "../components/settings-row.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import { projectWorkflowMachine, type WorkflowInput } from "./project-workflow-machine.js"

export interface ProjectWorkflowSettingsProps {
  projects: ReadonlyArray<Project>
  loading?: boolean
  onSave(input: WorkflowInput): Promise<void> | void
  onReadConfig?(projectId: string): Promise<ProjectConfig>
  /** Locate a missing project folder (same callback the sidebar uses). */
  onLocateProject?(projectId: string): Promise<void> | void
  onRemoveProject?(projectId: string): Promise<void> | void
  routines?: (projectId: string, templates?: ReadonlyArray<ProjectRoutineTemplate>) => ReactNode
}

export function ProjectWorkflowSettings({ projects, loading = false, onSave, onReadConfig, onLocateProject, onRemoveProject, routines }: ProjectWorkflowSettingsProps) {
  const [importedTemplates, setImportedTemplates] = useState<Record<string, ReadonlyArray<ProjectRoutineTemplate>>>({})
  const locals = projects.filter((project) => project.environmentId === undefined)
  const [projectId, setProjectId] = useState(locals[0]?.id ?? "")
  const project = locals.find((item) => item.id === projectId) ?? locals[0]
  // Pin the first asynchronously loaded local project so reorder cannot replace drafts.
  const resolvedProjectId = project?.id
  useEffect(() => {
    if (resolvedProjectId && resolvedProjectId !== projectId) setProjectId(resolvedProjectId)
  }, [resolvedProjectId, projectId])
  return (
    <div data-testid="project-settings-scroll" className="min-h-0 min-w-0 flex-1 overflow-auto p-6">
    <div className="mx-auto w-full max-w-3xl space-y-6" data-testid="project-workflow-settings">
      <div>
        <h2 className="text-[15px] font-semibold text-text-bright">Projects</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Machine-local commands and saved routines for your project.
        </p>
      </div>
      {project ? (
        <>
          <SettingsCard>
            <SettingsRow
              label={<span id="project-picker-label">Local project</span>}
              control={
                <div className="w-[220px]">
                  <Select value={project.id} onValueChange={setProjectId}>
                    <SelectTrigger aria-label="Local project" aria-labelledby="project-picker-label">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {locals.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              }
            />
            <MissingFolderRow project={project} onLocate={onLocateProject} onRemove={onRemoveProject} />
          </SettingsCard>
          <WorkflowEditor key={project.id} project={project} onSave={onSave} onReadConfig={onReadConfig} onConfigLoaded={(id, templates) => setImportedTemplates((current) => ({ ...current, [id]: templates }))} />
        </>
      ) : loading ? (
        <p role="status" className="text-[12px] text-muted-foreground">Loading local projects…</p>
      ) : (
        <p className="text-[12px] text-muted-foreground">Add a local project before configuring workspace commands.</p>
      )}
      {routines?.(project?.id ?? "", importedTemplates[project?.id ?? ""] ?? [])}
    </div>
    </div>
  )
}
type Draft = SnapshotFrom<typeof projectWorkflowMachine>["context"]["draft"]
type RunDraft = Draft["runs"][number]

/** Compact 32px geometry shared with the other restyled Settings sections. */
const controlClass = "h-8 w-[220px] rounded-[6px] px-2.5 text-[13px]"

/** Neutral Locate…/Remove row for a project whose folder is gone (same copy and callbacks as the sidebar tile menu). */
function MissingFolderRow({
  project,
  onLocate,
  onRemove,
}: {
  project: Project
  onLocate?: ProjectWorkflowSettingsProps["onLocateProject"]
  onRemove?: ProjectWorkflowSettingsProps["onRemoveProject"]
}) {
  const [confirming, setConfirming] = useState(false)
  if (project.availability !== "missing") return null
  return (
    <>
      <SettingsRow
        label={
          <span className="inline-flex items-center gap-1.5">
            <FolderX size={14} aria-hidden /> Folder not found
          </span>
        }
        help={project.path}
        control={
          <div className="flex gap-2">
            {onLocate && (
              <Button size="sm" variant="secondary" onClick={() => void onLocate(project.id)}>
                Locate…
              </Button>
            )}
            {onRemove && (
              <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
                Remove
              </Button>
            )}
          </div>
        }
      />
      {onRemove && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          destructive
          title={`Remove ${project.name}?`}
          description="This unregisters the project from Jingler. Files on disk are not deleted."
          confirmLabel="Remove project"
          onConfirm={() => onRemove(project.id)}
        />
      )}
    </>
  )
}

function RunRow({ run, index, draft, edit }: { run: RunDraft; index: number; draft: Draft; edit: (patch: Partial<Draft>) => void }) {
  const patchRun = (patch: Partial<RunDraft>) =>
    edit({ runs: draft.runs.map((item) => (item.id === run.id ? { ...item, ...patch } : item)) })
  const moveUp = () => {
    const runs = [...draft.runs]
    const previous = runs[index - 1]
    if (!previous) return
    runs[index - 1] = run
    runs[index] = previous
    edit({ runs })
  }
  return (
    <div data-testid="settings-row" className="flex flex-wrap items-center gap-2 px-4 py-3">
      <Input
        aria-label={`Run name ${index + 1}`}
        className="h-8 min-w-32 flex-1 rounded-[6px] px-2.5 text-[13px]"
        placeholder="Name"
        value={run.label}
        onChange={(event) => patchRun({ label: event.currentTarget.value })}
      />
      <Input
        aria-label={`Run command ${index + 1}`}
        className="h-8 min-w-48 flex-[2] rounded-[6px] px-2.5 text-[13px]"
        placeholder="Command"
        value={run.command}
        onChange={(event) => patchRun({ command: event.currentTarget.value })}
      />
      {index > 0 && (
        <Button size="sm" variant="outline" aria-label={`Move run command ${index + 1} up`} onClick={moveUp}>
          Move up
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        aria-label={`Remove run command ${index + 1}`}
        onClick={() => edit({ runs: draft.runs.filter((item) => item.id !== run.id) })}
      >
        Remove
      </Button>
    </div>
  )
}

function CommandsCard({ draft, busy, edit }: { draft: Draft; busy: boolean; edit: (patch: Partial<Draft>) => void }) {
  const addRun = () => edit({ runs: [...draft.runs, { id: `run-${crypto.randomUUID()}`, label: "", command: "" }] })
  return (
    <fieldset disabled={busy} className="m-0 min-w-0 space-y-2 border-0 p-0">
      <SettingsCard title="Commands">
        <SettingsRow
          label={<label htmlFor="workflow-setup">Setup command</label>}
          help="Commands and file copies run only after approving their exact content on this machine."
          control={
            <Input
              id="workflow-setup"
              aria-label="Setup command"
              className={controlClass}
              value={draft.setup}
              onChange={(event) => edit({ setup: event.currentTarget.value })}
              placeholder="pnpm install"
            />
          }
        />
        <SettingsRow
          label="Run commands"
          help={draft.runs.length === 0 ? "No run commands yet." : undefined}
          control={
            <Button size="sm" variant="outline" onClick={addRun}>
              Add run command
            </Button>
          }
        />
        {draft.runs.map((run, index) => (
          <RunRow key={run.id} run={run} index={index} draft={draft} edit={edit} />
        ))}
        <SettingsRow
          label={<label htmlFor="workflow-cleanup">Cleanup command</label>}
          control={
            <Input
              id="workflow-cleanup"
              aria-label="Cleanup command"
              className={controlClass}
              value={draft.cleanup}
              onChange={(event) => edit({ cleanup: event.currentTarget.value })}
              placeholder="docker compose down"
            />
          }
        />
        <SettingsRow
          label="Copy ignored files"
          help="Safe relative paths, one per line."
          control={
            <textarea
              aria-label="Copied files"
              className="min-h-20 w-[220px] rounded-[6px] border border-line bg-sunken p-2 text-[13px] text-text-bright"
              value={draft.copyFiles}
              onChange={(event) => edit({ copyFiles: event.currentTarget.value })}
              placeholder=".env.local"
            />
          }
        />
      </SettingsCard>
    </fieldset>
  )
}

function WorkflowEditor({
  project,
  onSave,
  onReadConfig,
  onConfigLoaded,
}: {
  project: Project
  onReadConfig?: ProjectWorkflowSettingsProps["onReadConfig"]
  onConfigLoaded: (projectId: string, templates: ReadonlyArray<ProjectRoutineTemplate>) => void
  onSave: ProjectWorkflowSettingsProps["onSave"]
}) {
  const [state, send] = useMachine(projectWorkflowMachine, { input: { project, onSave, onReadConfig, onConfigLoaded } })
  const { draft, approved, message, error } = state.context
  const busy = !state.matches("editing")
  const edit = (patch: Partial<typeof draft>) => send({ type: "EDIT", draft: { ...draft, ...patch } })
  return (
    <div className="space-y-6">
      {onReadConfig && (
        <SettingsCard>
          <SettingsRow
            label="Shared project config"
            help="Load shared commands and routine templates for review. Save and local approval remain explicit."
            control={
              <Button size="sm" variant="outline" disabled={busy} aria-busy={state.matches("readingConfig")} onClick={() => send({ type: "LOAD_CONFIG" })}>
                {state.matches("readingConfig") ? "Loading project configuration…" : "Load .jingler/project.json"}
              </Button>
            }
          />
        </SettingsCard>
      )}
      <CommandsCard draft={draft} busy={busy} edit={edit} />
      <div className="space-y-2">
        <SettingsCard>
          <SettingsRow
            label={
              <Checkbox
                id="workflow-approval"
                checked={approved}
                disabled={busy}
                onCheckedChange={(value) => send({ type: "APPROVE", approved: value })}
                label="I approve these commands and file copies on this machine. Editing any field revokes approval."
              />
            }
            control={
              <Button disabled={busy} onClick={() => send({ type: "SAVE" })}>
                {state.matches("saving") ? "Saving…" : "Save workflow"}
              </Button>
            }
          />
        </SettingsCard>
        {message && (
          <p role={error ? "alert" : "status"} className="px-1 text-[12px] text-muted-foreground">
            {message}
          </p>
        )}
      </div>
    </div>
  )
}
