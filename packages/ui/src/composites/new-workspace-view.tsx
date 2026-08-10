import * as React from "react"
import type {
  CliInfo,
  CliKind,
  CreateSessionInput,
  Environment,
  HarnessCapability,
  ProvidersConfig,
  Project
} from "@jingler/core"
import { supportsPlanMode } from "@jingler/core"
import { useMachine } from "@xstate/react"
import {
  Check,
  ChevronDown,
  FolderGit2,
  GitBranch,
  GitFork,
  MessageCircle,
  Monitor,
  X
} from "lucide-react"
import { Button } from "../components/button.js"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from "../components/command.js"
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover.js"
import { cn } from "../lib/cn.js"
import { Composer } from "./composer.js"
import { newWorkspaceMachine, type NewWorkspaceDeps } from "./new-workspace-machine.js"

interface PickerOption<T extends string> {
  value: T
  label: string
  description?: string
  keywords?: string
  disabled?: boolean
  icon: React.ReactNode
}

function SearchPicker<T extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  disabled,
  triggerClassName,
  contentClassName = "w-[380px]"
}: {
  value: T | ""
  options: ReadonlyArray<PickerOption<T>>
  onValueChange: (value: T) => void
  ariaLabel: string
  placeholder: string
  searchPlaceholder: string
  emptyLabel: string
  disabled?: boolean
  triggerClassName?: string
  contentClassName?: string
}) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((option) => option.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "flex h-10 min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-text outline-none transition-[background-color,color,transform] hover:bg-surface active:scale-[0.96] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring",
            triggerClassName
          )}
        >
          {selected?.icon}
          <span className={cn("min-w-0 flex-1 truncate", selected ? "text-text-bright" : "text-dim")}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown size={13} className="flex-none text-dim" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn("overflow-hidden p-0", contentClassName)}>
        <Command loop>
          <CommandInput autoFocus placeholder={searchPlaceholder} />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={`${option.label} ${option.keywords ?? ""}`}
                disabled={option.disabled}
                onSelect={() => {
                  onValueChange(option.value)
                  setOpen(false)
                }}
                className="min-h-11 gap-2.5"
              >
                {option.icon}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{option.label}</span>
                  {option.description && (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
                {option.value === value && <Check size={15} className="flex-none text-blue" aria-hidden />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export interface NewWorkspaceViewProps {
  open: boolean
  projects: ReadonlyArray<Project>
  environments?: ReadonlyArray<Environment>
  clis: ReadonlyArray<CliInfo>
  capabilities: ReadonlyArray<HarnessCapability>
  defaultCli?: CliKind | null
  defaultModel?: string | null
  providers?: ProvidersConfig | null
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

  React.useEffect(() => {
    if (props.open) send({ type: "SYNC_HARNESSES" })
  }, [props.open, props.capabilities, props.defaultCli, props.defaultModel, send])

  const { projectId, environmentId, isolation, baseBranch, branches, draft, cli, model, mode, reasoning, error } = state.context
  const selectedProject = props.projects.find((project) => project.id === projectId)
  const submitting = state.matches("submitting")
  const loading = state.matches("loading")
  const unavailableReason = submitting
    ? "Creating session…"
    : loading
      ? environmentId === "local" ? "Loading branches…" : "Preparing project on host…"
      : props.projects.length === 0
        ? "Add a project before starting a session."
        : props.capabilities.length === 0
          ? "No harnesses are available. Check Settings → Providers."
          : !projectId || !baseBranch || !cli || !model
            ? "Choose a project and branch before starting."
            : undefined

  const projectOptions: ReadonlyArray<PickerOption<string>> = props.projects.map((project) => ({
    value: project.id,
    label: project.name,
    description: project.availability === "available" ? project.path : "Unavailable on this host",
    keywords: project.path,
    disabled: project.availability !== "available",
    icon: <FolderGit2 size={16} className="flex-none text-blue" aria-hidden />
  }))
  const checkoutOptions: ReadonlyArray<PickerOption<"worktree" | "direct">> = [
    {
      value: "worktree",
      label: "Worktree",
      description: "Create an isolated Git worktree",
      keywords: "new isolated branch",
      icon: <GitFork size={16} className="flex-none text-purple" aria-hidden />
    },
    {
      value: "direct",
      label: "Local",
      description: "Use the existing project checkout",
      keywords: "host direct checkout",
      icon: <Monitor size={16} className="flex-none text-muted-foreground" aria-hidden />
    }
  ]
  const branchOptions: ReadonlyArray<PickerOption<string>> = branches.map((branch) => ({
    value: branch,
    label: branch,
    keywords: branch.replaceAll("/", " "),
    icon: <GitBranch size={16} className="flex-none text-cyan" aria-hidden />
  }))

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
          <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
            <div className="flex flex-col gap-0.5">
              <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">Project</span>
              <SearchPicker
                value={projectId}
                options={projectOptions}
                onValueChange={(value) => send({ type: "SET_PROJECT", projectId: value })}
                ariaLabel="Project"
                placeholder="Choose project"
                searchPlaceholder="Search projects…"
                emptyLabel="No projects match."
                disabled={loading}
                triggerClassName="w-[240px]"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">Checkout mode</span>
              <SearchPicker
                value={isolation}
                options={checkoutOptions}
                onValueChange={(value) => send({ type: "SET_ISOLATION", isolation: value })}
                ariaLabel="Checkout"
                placeholder="Choose checkout"
                searchPlaceholder="Search checkout modes…"
                emptyLabel="No checkout modes match."
                disabled={loading}
                triggerClassName="w-[240px]"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">Base branch</span>
              <SearchPicker
                value={baseBranch}
                options={branchOptions}
                onValueChange={(value) => send({ type: "SET_BASE", baseBranch: value })}
                ariaLabel="Base branch"
                placeholder={loading ? (environmentId === "local" ? "Loading branches…" : "Preparing on host…") : "Choose branch"}
                searchPlaceholder="Search branches…"
                emptyLabel="No branches match."
                disabled={loading}
                triggerClassName="w-[240px]"
              />
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
            onSetEnvironment={(value) => send({ type: "SET_ENVIRONMENT", environmentId: value ?? "local" })}
            cli={cli || undefined}
            model={model || undefined}
            capabilities={props.capabilities}
            onSetHarness={(nextCli, nextModel) =>
              send({ type: "SET_HARNESS", cli: nextCli, model: nextModel })}
            mode={mode}
            onSetMode={(value) => send({ type: "SET_MODE", mode: value })}
            reasoningEffort={reasoning?.effort}
            thinkingEnabled={reasoning?.enabled}
            onSetReasoning={(value) => send({ type: "SET_REASONING", reasoning: value })}
            allowPlan={cli !== "" && supportsPlanMode(cli)}
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
