import * as React from "react"
import type { CliInfo, CliKind, CreateSessionInput, Environment, Project } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { FolderGit2, GitBranch, GitFork, MessageCircle, X } from "lucide-react"
import { Button } from "../components/button.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/select.js"
import { Composer } from "./composer.js"
import { newWorkspaceMachine, type NewWorkspaceDeps } from "./new-workspace-machine.js"

export interface NewWorkspaceViewProps {
  open: boolean
  projects: ReadonlyArray<Project>
  environments?: ReadonlyArray<Environment>
  clis: ReadonlyArray<CliInfo>
  defaultCli?: CliKind | null
  defaultProjectId?: string | null
  requestedProjectId?: string | null
  prepareProject: NewWorkspaceDeps["prepareProject"]
  loadBranches: NewWorkspaceDeps["loadBranches"]
  onCreate: (input: CreateSessionInput) => Promise<void>
  onAddProject?: () => void
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

  React.useEffect(() => {
    if (!props.open || state.context.projectId !== "") return
    const project = props.projects.find((candidate) => candidate.availability === "available")
    if (project) send({ type: "SET_PROJECT", projectId: project.id })
  }, [props.open, props.projects, send, state.context.projectId])

  const { projectId, environmentId, isolation, baseBranch, branches, draft, cli, error } = state.context
  const selectedProject = props.projects.find((project) => project.id === projectId)
  const submitting = state.matches("submitting")
  const loading = state.matches("loading")
  const unavailableReason = submitting
    ? "Creating session…"
    : loading
      ? environmentId === "local" ? "Loading branches…" : "Preparing project on host…"
      : props.projects.length === 0
        ? "Add a project before starting a session."
        : !projectId || !baseBranch || !cli
          ? "Choose a project and branch before starting."
          : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-editor" data-testid="new-session-view">
      <div className="flex h-12 flex-none items-center border-b border-hairline px-5">
        <h1 className="text-[13px] font-semibold text-text-bright">New session</h1>
        <span className="flex-1" />
        <Button variant="ghost" size="icon" aria-label="Close new session" onClick={() => send({ type: "CLOSE" })}>
          <X size={15} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto px-6 py-10">
        <div className="m-auto flex w-full max-w-[920px] flex-col gap-5">
          <div className="flex items-center gap-3">
            <div>
              <h2 className="text-[20px] font-semibold tracking-[-0.2px] text-text-bright">What are we working on?</h2>
              <p className="mt-1 text-[12px] text-muted-foreground">Choose the checkout, then send the first message with the same composer used in a session.</p>
            </div>
            <span className="flex-1" />
            {props.onAddProject && (
              <Button variant="secondary" onClick={props.onAddProject}>
                <FolderGit2 size={14} /> Add project
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
            <div className="flex flex-col gap-0.5">
              <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">Project</span>
              <Select value={projectId} onValueChange={(value) => send({ type: "SET_PROJECT", projectId: value })} disabled={loading}>
                <SelectTrigger
                  aria-label="Project"
                  className="h-10 w-auto min-w-[120px] justify-start border-transparent bg-transparent px-2 hover:bg-surface focus:border-transparent"
                >
                  <FolderGit2 size={15} className="flex-none text-blue" aria-hidden="true" />
                  <SelectValue placeholder="Choose project" />
                </SelectTrigger>
                <SelectContent>
                  {props.projects.map((project) => (
                    <SelectItem key={project.id} value={project.id} disabled={project.availability !== "available"}>
                      {project.name}{project.availability !== "available" ? " (unavailable)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">Checkout mode</span>
              <Select value={isolation} onValueChange={(value) => send({ type: "SET_ISOLATION", isolation: value as "worktree" | "direct" })} disabled={loading}>
                <SelectTrigger
                  aria-label="Checkout"
                  className="h-10 w-auto min-w-[140px] justify-start border-transparent bg-transparent px-2 hover:bg-surface focus:border-transparent"
                >
                  <GitFork size={15} className="flex-none text-muted-foreground" aria-hidden="true" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="worktree">New worktree</SelectItem>
                  <SelectItem value="direct">Host checkout</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">Base branch</span>
              <Select value={baseBranch} onValueChange={(value) => send({ type: "SET_BASE", baseBranch: value })} disabled={loading}>
                <SelectTrigger
                  aria-label="Base branch"
                  className="h-10 w-auto min-w-[110px] justify-start border-transparent bg-transparent px-2 hover:bg-surface focus:border-transparent"
                >
                  <GitBranch size={15} className="flex-none text-cyan" aria-hidden="true" />
                  <SelectValue placeholder={loading ? (environmentId === "local" ? "Loading branches…" : "Preparing on host…") : "Base branch"} />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branch) => <SelectItem key={branch} value={branch}>{branch}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Composer
            autoFocus
            focusKey="new-session"
            value={draft}
            onValueChange={(value) => send({ type: "SET_DRAFT", draft: value })}
            onSend={() => send({ type: "SUBMIT" })}
            placeholder="Message the agent, tag @files, or use /commands and /skills"
            repo={selectedProject?.name}
            branch={baseBranch}
            environments={props.environments}
            environmentId={environmentId === "local" ? undefined : environmentId}
            environmentPending={loading}
            onSetEnvironment={(value) => send({ type: "SET_ENVIRONMENT", environmentId: value ?? "local" })}
            cli={cli || undefined}
            disabledReason={unavailableReason}
          />
          {draft.trim().length === 0 && unavailableReason === undefined && (
            <div className="flex justify-end">
              <Button variant="secondary" aria-label="Create workspace" onClick={() => send({ type: "SUBMIT" })}>
                <MessageCircle size={14} /> Create without a first message
              </Button>
            </div>
          )}
          {error && <p role="alert" className="text-[11px] text-red">{error}</p>}
        </div>
      </div>
    </div>
  )
}
