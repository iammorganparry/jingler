import { useEffect, useState, type ReactNode } from "react"
import type { Project } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { Button } from "../components/button.js"
import { Checkbox } from "../components/checkbox.js"
import { Input } from "../components/input.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import { projectWorkflowMachine, type WorkflowInput } from "./project-workflow-machine.js"

export interface ProjectWorkflowSettingsProps {
  projects: ReadonlyArray<Project>
  loading?: boolean
  onSave(input: WorkflowInput): Promise<void> | void
  routines?: (projectId: string) => ReactNode
}

export function ProjectWorkflowSettings({ projects, loading = false, onSave, routines }: ProjectWorkflowSettingsProps) {
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
        <h2 className="text-lg font-semibold text-text-bright">Projects</h2>
        <p className="mt-1 text-sm text-dim">
          Machine-local commands, preview ports and saved routines for your project.
        </p>
      </div>
      {project ? (
        <>
          <div className="space-y-1">
            <p id="project-picker-label" className="text-sm text-text-bright">
              Local project
            </p>
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
          <WorkflowEditor key={project.id} project={project} onSave={onSave} />
        </>
      ) : loading ? (
        <p role="status" className="text-sm text-dim">Loading local projects…</p>
      ) : (
        <p className="text-sm text-dim">Add a local project before configuring workspace commands.</p>
      )}
      {routines?.(project?.id ?? "")}
    </div>
    </div>
  )
}
function WorkflowEditor({
  project,
  onSave,
}: {
  project: Project
  onSave: ProjectWorkflowSettingsProps["onSave"]
}) {
  const [state, send] = useMachine(projectWorkflowMachine, { input: { project, onSave } })
  const { draft, approved, message, error } = state.context
  const busy = state.matches("saving")
  const edit = (patch: Partial<typeof draft>) => send({ type: "EDIT", draft: { ...draft, ...patch } })
  return (
    <div className="space-y-6">
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <legend className="mb-2 font-semibold text-text-bright">Commands</legend>
        <p className="text-sm text-dim">
          Commands and file copies run only after approving their exact content on this machine.
        </p>
        <label className="block space-y-1 text-sm text-text-bright" htmlFor="workflow-setup">
          Setup command
          <Input
            id="workflow-setup"
            aria-label="Setup command"
            value={draft.setup}
            onChange={(event) => edit({ setup: event.currentTarget.value })}
            placeholder="pnpm install"
          />
        </label>
        <div className="space-y-2">
          <h3 className="text-sm text-text-bright">Run commands</h3>
          {draft.runs.length === 0 && <p className="text-sm text-dim">No run commands yet.</p>}
          {draft.runs.map((run, index) => (
            <div key={run.id} className="flex flex-wrap items-end gap-2">
              <label className="min-w-32 flex-1 text-sm text-text-bright" htmlFor={`run-name-${run.id}`}>
                Name
                <Input
                  id={`run-name-${run.id}`}
                  aria-label={`Run name ${index + 1}`}
                  value={run.label}
                  onChange={(event) =>
                    edit({
                      runs: draft.runs.map((item) =>
                        item.id === run.id ? { ...item, label: event.currentTarget.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <label className="min-w-48 flex-[2] text-sm text-text-bright" htmlFor={`run-command-${run.id}`}>
                Command
                <Input
                  id={`run-command-${run.id}`}
                  aria-label={`Run command ${index + 1}`}
                  value={run.command}
                  onChange={(event) =>
                    edit({
                      runs: draft.runs.map((item) =>
                        item.id === run.id ? { ...item, command: event.currentTarget.value } : item,
                      ),
                    })
                  }
                />
              </label>
              {index > 0 && (
                <Button
                  variant="outline"
                  aria-label={`Move run command ${index + 1} up`}
                  onClick={() => {
                    const runs = [...draft.runs]
                    const previous = runs[index - 1]
                    if (previous) {
                      runs[index - 1] = run
                      runs[index] = previous
                      edit({ runs })
                    }
                  }}
                >
                  Move up
                </Button>
              )}
              <Button
                variant="outline"
                aria-label={`Remove run command ${index + 1}`}
                onClick={() => edit({ runs: draft.runs.filter((item) => item.id !== run.id) })}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            onClick={() =>
              edit({ runs: [...draft.runs, { id: `run-${crypto.randomUUID()}`, label: "", command: "" }] })
            }
          >
            Add run command
          </Button>
        </div>
        <label className="block space-y-1 text-sm text-text-bright" htmlFor="workflow-cleanup">
          Cleanup command
          <Input
            id="workflow-cleanup"
            aria-label="Cleanup command"
            value={draft.cleanup}
            onChange={(event) => edit({ cleanup: event.currentTarget.value })}
            placeholder="docker compose down"
          />
        </label>
        <label className="block space-y-1 text-sm text-text-bright">
          Copy ignored files <span className="text-dim">(safe relative paths, one per line)</span>
          <textarea
            aria-label="Copied files"
            className="min-h-20 w-full rounded-md border border-line bg-sunken p-2 text-sm text-text-bright"
            value={draft.copyFiles}
            onChange={(event) => edit({ copyFiles: event.currentTarget.value })}
            placeholder=".env.local"
          />
        </label>
      </fieldset>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <legend className="mb-2 font-semibold text-text-bright">Ports &amp; preview</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-text-bright" htmlFor="workflow-primary">
            Starting app port
            <Input
              id="workflow-primary"
              aria-label="Starting app port"
              type="number"
              min={1024}
              max={65535}
              value={draft.primary}
              onChange={(event) => edit({ primary: event.currentTarget.value })}
            />
          </label>
          <label className="text-sm text-text-bright" htmlFor="workflow-preview">
            Preview URL template
            <Input
              id="workflow-preview"
              aria-label="Preview URL template"
              value={draft.previewUrl}
              onChange={(event) => edit({ previewUrl: event.currentTarget.value })}
            />
          </label>
        </div>
        <p className="text-xs text-dim">
          Use {"{port}"} for the app port or {"{API_port}"} for a named service. Commands receive JINGLER_PORT
          and JINGLER_API_PORT.
        </p>
        {draft.extras.length === 0 && <p className="text-sm text-dim">No additional service ports.</p>}
        {draft.extras.map((extra, index) => (
          <div key={extra.id} className="flex flex-wrap items-end gap-2">
            <label className="min-w-32 flex-1 text-sm text-text-bright" htmlFor={`service-name-${extra.id}`}>
              Service name
              <Input
                id={`service-name-${extra.id}`}
                aria-label={`Service name ${index + 1}`}
                value={extra.name}
                onChange={(event) =>
                  edit({
                    extras: draft.extras.map((item) =>
                      item.id === extra.id ? { ...item, name: event.currentTarget.value } : item,
                    ),
                  })
                }
              />
            </label>
            <label className="min-w-32 flex-1 text-sm text-text-bright" htmlFor={`service-port-${extra.id}`}>
              Starting port
              <Input
                id={`service-port-${extra.id}`}
                aria-label={`Service port ${index + 1}`}
                type="number"
                value={extra.start}
                onChange={(event) =>
                  edit({
                    extras: draft.extras.map((item) =>
                      item.id === extra.id ? { ...item, start: event.currentTarget.value } : item,
                    ),
                  })
                }
              />
            </label>
            <Button
              variant="outline"
              aria-label={`Remove service port ${index + 1}`}
              onClick={() => edit({ extras: draft.extras.filter((item) => item.id !== extra.id) })}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          onClick={() =>
            edit({ extras: [...draft.extras, { id: crypto.randomUUID(), name: "", start: "" }] })
          }
        >
          Add service port
        </Button>
      </fieldset>
      <div className="space-y-3 border-t border-line pt-4">
        <Checkbox
          id="workflow-approval"
          checked={approved}
          disabled={busy}
          onCheckedChange={(value) => send({ type: "APPROVE", approved: value })}
          label="I approve these commands and file copies on this machine. Editing any field revokes approval."
        />
        <div>
          <Button disabled={busy} onClick={() => send({ type: "SAVE" })}>
            {busy ? "Saving…" : "Save workflow"}
          </Button>
        </div>
        {message && (
          <p role={error ? "alert" : "status"} className="text-sm text-dim">
            {message}
          </p>
        )}
      </div>
    </div>
  )
}
