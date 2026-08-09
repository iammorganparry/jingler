import * as React from "react"
import type { CliInfo, CliKind, CreateSessionInput, Project } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { GitBranch, MessageCircle, Send } from "lucide-react"
import { Button } from "../components/button.js"
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../components/dialog.js"
import { Input } from "../components/input.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/select.js"
import { newWorkspaceMachine, type NewWorkspaceDeps } from "./new-workspace-machine.js"

export interface NewWorkspaceViewProps {
  open: boolean
  projects: ReadonlyArray<Project>
  clis: ReadonlyArray<CliInfo>
  defaultCli?: CliKind | null
  defaultProjectId?: string | null
  requestedProjectId?: string | null
  loadBranches: NewWorkspaceDeps["loadBranches"]
  onCreate: (input: CreateSessionInput) => Promise<void>
  onClose: () => void
}

export function NewWorkspaceView(props: NewWorkspaceViewProps) {
  const depsRef = React.useRef<NewWorkspaceDeps>(props)
  depsRef.current = props
  const getDeps = React.useCallback(() => depsRef.current, [])
  const [state, send] = useMachine(newWorkspaceMachine, { input: { getDeps } })

  React.useEffect(() => {
    if (props.open) send({ type: "OPEN", ...(props.requestedProjectId ? { projectId: props.requestedProjectId } : {}) })
    else send({ type: "CLOSE" })
  }, [props.open, props.requestedProjectId, send])

  const { projectId, isolation, baseBranch, branches, title, draft, cli, error } = state.context
  const selectedProject = props.projects.find((project) => project.id === projectId)
  const submitting = state.matches("submitting")
  const loading = state.matches("loading")
  const harness = props.clis.find((candidate) => candidate.kind === cli)

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open) send({ type: "CLOSE" }) }}>
      <DialogContent className="max-w-[920px]">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-5 p-6">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Select value={projectId} onValueChange={(value) => send({ type: "SET_PROJECT", projectId: value })}>
              <SelectTrigger aria-label="Project"><SelectValue placeholder="Choose project" /></SelectTrigger>
              <SelectContent>
                {props.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id} disabled={project.availability !== "available"}>
                    {project.name}{project.availability !== "available" ? " (unavailable)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={isolation} onValueChange={(value) => send({ type: "SET_ISOLATION", isolation: value as "worktree" | "direct" })}>
              <SelectTrigger aria-label="Checkout"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="worktree">New worktree</SelectItem>
                <SelectItem value="direct">Local checkout</SelectItem>
              </SelectContent>
            </Select>
            <Select value={baseBranch} onValueChange={(value) => send({ type: "SET_BASE", baseBranch: value })} disabled={loading}>
              <SelectTrigger aria-label="Base branch"><SelectValue placeholder={loading ? "Loading branches…" : "Base branch"} /></SelectTrigger>
              <SelectContent>
                {branches.map((branch) => <SelectItem key={branch} value={branch}>{branch}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <Input
            aria-label="Workspace name"
            placeholder="Workspace name (optional — the agent can name it)"
            value={title}
            onChange={(event) => send({ type: "SET_TITLE", title: event.currentTarget.value })}
          />

          <div className="rounded-2xl border border-line bg-sunken p-4 shadow-sm">
            <textarea
              autoFocus
              aria-label="First task"
              placeholder="Message the agent, tag @files, or use /commands and /skills"
              value={draft}
              onChange={(event) => send({ type: "SET_DRAFT", draft: event.currentTarget.value })}
              className="min-h-32 w-full resize-none bg-transparent text-[13px] leading-6 text-text outline-none placeholder:text-dim"
            />
            <div className="flex items-center gap-2 border-t border-hairline pt-3">
              <span className="flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[11px] text-text">
                {cli && <ProviderIcon cli={cli} className="size-3.5" />}
                {(harness?.label ?? cli) || "No harness"}
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <GitBranch size={13} /> {selectedProject?.name ?? "Project"} · {baseBranch || "branch"}
              </span>
              <span className="flex-1" />
              <Button
                aria-label="Create workspace"
                disabled={!projectId || !baseBranch || !cli || submitting}
                onClick={() => send({ type: "SUBMIT" })}
              >
                {draft.trim() ? <Send size={14} /> : <MessageCircle size={14} />}
                {submitting ? "Creating…" : draft.trim() ? "Create and start" : "Create workspace"}
              </Button>
            </div>
          </div>
          {error && <p role="alert" className="text-[11px] text-red">{error}</p>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
