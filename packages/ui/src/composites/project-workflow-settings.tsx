import * as React from "react"
import type { Project, ProjectRunCommand } from "@jingler/core"
import { Button } from "../components/button.js"
import { Input } from "../components/input.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"

export interface ProjectWorkflowSettingsProps {
  projects: ReadonlyArray<Project>
  onSave: (input: {
    projectId: string
    setup?: string
    cleanup?: string
    runs: ReadonlyArray<ProjectRunCommand>
    ports?: import("@jingler/core").WorkspacePortConfig
    copyFiles: ReadonlyArray<string>
    approve: boolean
  }) => Promise<void> | void
}

const runsText = (project: Project | undefined): string =>
  (project?.workflow?.runs ?? []).map((run) => `${run.label}=${run.command}`).join("\n")

const portsOf = (project: Project | undefined) => project?.workflow?.ports ?? { primary: 3100, extras: [], previewUrl: "http://localhost:{port}" }

export function ProjectWorkflowSettings({ projects, onSave }: ProjectWorkflowSettingsProps) {
  const [projectId, setProjectId] = React.useState(projects[0]?.id ?? "")
  const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0]
  const [setup, setSetup] = React.useState(project?.workflow?.setup ?? "")
  const [cleanup, setCleanup] = React.useState(project?.workflow?.cleanup ?? "")
  const [runs, setRuns] = React.useState(runsText(project))
  const [copyFiles, setCopyFiles] = React.useState((project?.workflow?.copyFiles ?? []).join("\n"))
  const [ports, setPorts] = React.useState(portsOf(project))
  const [approved, setApproved] = React.useState(project?.workflow?.approvedDigest !== undefined)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  const selectProject = (id: string) => {
    const next = projects.find((candidate) => candidate.id === id)
    setProjectId(id)
    setSetup(next?.workflow?.setup ?? "")
    setCleanup(next?.workflow?.cleanup ?? "")
    setRuns(runsText(next))
    setCopyFiles((next?.workflow?.copyFiles ?? []).join("\n"))
    setPorts(portsOf(next))
    setApproved(next?.workflow?.approvedDigest !== undefined)
    setMessage(null)
  }

  const save = async () => {
    if (!project) return
    const parsedRuns = runs.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const separator = line.indexOf("=")
      const label = separator < 0 ? line : line.slice(0, separator).trim()
      const command = separator < 0 ? "" : line.slice(separator + 1).trim()
      return { id: `run-${index + 1}`, label, command }
    }).filter((run) => run.label && run.command)
    setBusy(true)
    setMessage(null)
    try {
      await onSave({
        projectId: project.id,
        ...(setup.trim() ? { setup: setup.trim() } : {}),
        ...(cleanup.trim() ? { cleanup: cleanup.trim() } : {}),
        runs: parsedRuns,
        ports: { ...ports, previewUrl: ports.previewUrl?.trim() || undefined },
        copyFiles: copyFiles.split("\n").map((line) => line.trim()).filter(Boolean),
        approve: approved
      })
      setMessage(approved ? "Saved and approved for this exact content." : "Saved without approval. Commands will not run.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save project workflow.")
    } finally {
      setBusy(false)
    }
  }

  if (!project) return <p className="text-sm text-dim">Add a local project before configuring workspace commands.</p>

  return (
    <div className="space-y-5" data-testid="project-workflow-settings">
      <div>
        <label htmlFor="workspace-primary-port" className="text-sm text-text-bright">Starting app port
          <Input id="workspace-primary-port" aria-label="Starting app port" type="number" min={1024} max={65535} value={ports.primary} onChange={(event) => { setPorts({ ...ports, primary: Number(event.currentTarget.value) }); setApproved(false) }} />
        </label>
        <label htmlFor="workspace-preview-template" className="text-sm text-text-bright">Preview URL template
          <Input id="workspace-preview-template" aria-label="Preview URL template" value={ports.previewUrl ?? ""} placeholder="http://localhost:{port}" onChange={(event) => { setPorts({ ...ports, previewUrl: event.currentTarget.value }); setApproved(false) }} />
        </label>
        <p className="text-xs text-dim">Use {"{port}"} for the app port or {"{API_port}"} for a named service. Commands receive JINGLER_PORT and JINGLER_API_PORT.</p>
        <label htmlFor="workspace-extra-ports" className="text-sm text-text-bright">Additional service ports (NAME=starting port)
          <textarea id="workspace-extra-ports" aria-label="Additional service ports" className="w-full border border-line bg-sunken text-text-bright" value={ports.extras.map((extra) => `${extra.name}=${extra.start}`).join("\n")} onChange={(event) => { setPorts({ ...ports, extras: event.currentTarget.value.split("\n").filter(Boolean).map((line) => { const [name, start] = line.split("="); return { name: name ?? "", start: Number(start) } }) }); setApproved(false) }} />
        </label>
      </div>
      <div>
        <h2 className="text-lg font-semibold text-text-bright">Project workflows</h2>
        <p className="mt-1 text-sm text-dim">Machine-local commands run only after approving their exact content.</p>
      </div>
      <Select value={project.id} onValueChange={selectProject}>
        <SelectTrigger aria-label="Workflow project"><SelectValue /></SelectTrigger>
        <SelectContent>{projects.filter((item) => item.environmentId === undefined).map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
      </Select>
      <label className="block text-sm text-text-bright">Setup command
        <Input className="mt-1" aria-label="Setup command" value={setup} onChange={(event) => { setSetup(event.currentTarget.value); setApproved(false) }} placeholder="pnpm install" />
      </label>
      <label className="block text-sm text-text-bright">Run commands <span className="text-dim">(one label=command per line)</span>
        <textarea className="mt-1 min-h-24 w-full rounded-md border border-line bg-sunken p-2 font-mono text-sm text-text-bright" aria-label="Run commands" value={runs} onChange={(event) => { setRuns(event.currentTarget.value); setApproved(false) }} placeholder="Dev server=pnpm dev" />
      </label>
      <label className="block text-sm text-text-bright">Cleanup command
        <Input className="mt-1" aria-label="Cleanup command" value={cleanup} onChange={(event) => { setCleanup(event.currentTarget.value); setApproved(false) }} placeholder="docker compose down" />
      </label>
      <label className="block text-sm text-text-bright">Copy ignored files <span className="text-dim">(safe relative paths, one per line)</span>
        <textarea className="mt-1 min-h-20 w-full rounded-md border border-line bg-sunken p-2 font-mono text-sm text-text-bright" aria-label="Copied files" value={copyFiles} onChange={(event) => { setCopyFiles(event.currentTarget.value); setApproved(false) }} placeholder=".env.local" />
      </label>
      <label className="flex items-start gap-2 text-sm text-text-bright">
        <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.currentTarget.checked)} />
        I approve these commands and file copies on this machine. Editing any field revokes approval.
      </label>
      <Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save workflow"}</Button>
      {message ? <p role="status" className="text-sm text-dim">{message}</p> : null}
    </div>
  )
}
