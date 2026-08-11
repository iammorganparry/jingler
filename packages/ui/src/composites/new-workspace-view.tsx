import * as React from "react"
import type {
  CliInfo,
  CliKind,
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
  CircleDot,
  FolderGit2,
  GitBranch,
  GitFork,
  GitPullRequest,
  MessageCircle,
  Monitor,
  Sparkles,
  X
} from "lucide-react"
import { Button } from "../components/button.js"
import { GithubMark } from "../components/github-mark.js"
import { LinearMark } from "../components/linear-mark.js"
import { SearchInput } from "../components/search-input.js"
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
import { IssuePickerList } from "./issue-picker-list.js"
import { newWorkspaceMachine, type NewSessionSource, type NewWorkspaceDeps } from "./new-workspace-machine.js"
import { PrPickerList } from "./pr-picker-list.js"

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
  issueProviders?: NewWorkspaceDeps["issueProviders"]
  loadPullRequests?: NewWorkspaceDeps["loadPullRequests"]
  loadGithubIssues?: NewWorkspaceDeps["loadGithubIssues"]
  loadProviderIssues?: NewWorkspaceDeps["loadProviderIssues"]
  onCreate: NewWorkspaceDeps["onCreate"]
  onCreateFromPr?: NewWorkspaceDeps["onCreateFromPr"]
  onCreateFromIssue?: NewWorkspaceDeps["onCreateFromIssue"]
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

  const {
    projectId, environmentId, isolation, baseBranch, branches, source, search, mine,
    pullRequests, issues, selectedPr, selectedIssue, draft, attachments, cli, model,
    mode, reasoning, error
  } = state.context
  const selectedProject = props.projects.find((project) => project.id === projectId)
  const selectedEnvironment = props.environments?.find(
    (environment) => environment.id === environmentId
  )
  const submitting = state.matches("submitting")
  const loading = state.matches("loading")
  const sourceLoading = state.matches("sourceLoading")
  const unavailableReason = submitting
    ? "Creating session…"
    : loading
      ? environmentId === "local" || selectedEnvironment?.kind === "managed"
        ? "Loading branches…"
        : "Preparing project on host…"
      : props.projects.length === 0
        ? "Add a project before starting a session."
        : props.capabilities.length === 0
          ? "No harnesses are available. Check Settings → Providers."
          : source === "pr" && selectedPr === null
            ? "Choose a pull request before starting."
            : (source === "github" || source.startsWith("provider:")) && selectedIssue === null
              ? "Choose an issue before starting."
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
  const sourceOptions: ReadonlyArray<{
    value: NewSessionSource
    label: string
    description: string
    icon: React.ReactNode
  }> = [
    { value: "blank", label: "Blank task", description: "Start from a base branch", icon: <Sparkles size={15} className="text-blue" /> },
    { value: "branch", label: "Existing branch", description: "Continue work already started", icon: <GitBranch size={15} className="text-cyan" /> },
    ...(props.loadPullRequests ? [{ value: "pr" as const, label: "Pull request", description: "Work on an open GitHub PR", icon: <GitPullRequest size={15} className="text-green" /> }] : []),
    ...(props.loadGithubIssues ? [{ value: "github" as const, label: "GitHub issue", description: "Link and prefill from GitHub", icon: <GithubMark className="size-[15px] text-text" /> }] : []),
    ...(props.issueProviders ?? []).map((provider) => ({
      value: `provider:${provider.id}` as const,
      label: `${provider.label} issue`,
      description: `Link and prefill from ${provider.label}`,
      icon: provider.id === "linear"
        ? <LinearMark className="size-[15px] text-text-bright" />
        : <CircleDot size={15} className="text-purple" />
    }))
  ]
  const selectedSource = sourceOptions.find((option) => option.value === source)
  const sourceLabel = selectedSource?.label ?? "issue"

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
        <div className="m-auto flex w-full max-w-[1040px] flex-col gap-6">
          <div className="flex items-center gap-3">
            <div>
              <h2 className="text-[20px] font-semibold tracking-[-0.2px] text-text-bright">What are we working on?</h2>
              <p className="mt-1 max-w-[62ch] text-pretty text-[12px] leading-relaxed text-muted-foreground">Choose where the work starts, configure its checkout, then send the first message.</p>
            </div>
            <span className="flex-1" />
            {props.onAddProject && (
              <Button variant="secondary" onClick={props.onAddProject}>
                <FolderGit2 size={14} /> Add project
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
              Start from
            </span>
            <div
              className="grid grid-cols-[repeat(auto-fit,minmax(156px,1fr))] gap-2"
              role="radiogroup"
              aria-label="Session source"
            >
              {sourceOptions.map((option) => {
                const selected = option.value === source
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => send({ type: "SET_SOURCE", source: option.value })}
                    className={cn(
                      "group flex min-h-[74px] min-w-0 flex-col justify-center gap-1.5 rounded-lg border px-3.5 text-left outline-none transition-[background-color,border-color,transform] active:translate-y-px focus-visible:ring-2 focus-visible:ring-ring",
                      selected ? "border-brand/60 bg-selection" : "border-line bg-sunken hover:border-line-strong hover:bg-surface"
                    )}
                  >
                    <span className="flex items-center gap-2 text-[12.5px] font-semibold text-text-bright">
                      {option.icon}<span className="truncate">{option.label}</span>
                    </span>
                    <span className="truncate text-[10.5px] text-dim">{option.description}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] items-end gap-3">
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
                triggerClassName="w-full"
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
                triggerClassName="w-full"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                {source === "branch" || source === "pr" ? "Working branch" : "Base branch"}
              </span>
              <SearchPicker
                value={source === "pr" ? selectedPr?.headRefName ?? "" : baseBranch}
                options={branchOptions}
                onValueChange={(value) => send({ type: "SET_BASE", baseBranch: value })}
                ariaLabel="Base branch"
                placeholder={loading ? (environmentId === "local" ? "Loading branches…" : "Preparing on host…") : "Choose branch"}
                searchPlaceholder="Search branches…"
                emptyLabel="No branches match."
                disabled={loading || source === "pr"}
                triggerClassName="w-full"
              />
            </div>
          </div>

          {source !== "blank" && source !== "branch" && (
            <section className="overflow-hidden rounded-xl border border-line bg-panel" aria-label="Source picker">
              <header className="flex items-center gap-2 border-b border-line px-4 py-3">
                <span className="text-text-bright">{selectedSource?.icon}</span>
                <h3 className="text-[12px] font-semibold text-text-bright">{sourceLabel}s</h3>
                <span className="text-[10.5px] text-dim">Choose one to prefill this session</span>
              </header>
              <div className="flex items-center gap-2 px-3 pt-3">
                <SearchInput
                  value={search}
                  onChange={(value) => send({ type: "SET_SEARCH", search: value })}
                  placeholder={source === "pr" ? "Search pull requests…" : `Search ${sourceLabel.toLowerCase()}s…`}
                  className="flex-1"
                />
                <Button
                  variant={mine ? "primary" : "secondary"}
                  className="h-[34px]"
                  aria-pressed={mine}
                  onClick={() => send({ type: "SET_MINE", mine: !mine })}
                >
                  Just mine
                </Button>
              </div>
              <div className="p-3">
                {source === "pr" ? (
                  <PrPickerList
                    prs={pullRequests}
                    selected={selectedPr?.number ?? null}
                    onSelect={(pr) => send({ type: "SELECT_PR", pr })}
                    loading={sourceLoading}
                  />
                ) : (
                  <IssuePickerList
                    issues={issues}
                    selected={selectedIssue?.id ?? null}
                    onSelect={(issue) => send({ type: "SELECT_ISSUE", issue })}
                    loading={sourceLoading}
                  />
                )}
              </div>
            </section>
          )}

          {source === "branch" && (
            <p className="rounded-lg border border-line bg-sunken px-3 py-2 text-[11px] text-muted-foreground">
              The selected branch will be checked out directly in the session worktree; Jingler will not create a replacement task branch.
            </p>
          )}

          <Composer
            autoFocus
            focusKey="new-session"
            value={draft}
            onValueChange={(value) => send({ type: "SET_DRAFT", draft: value })}
            attachments={attachments}
            onAttachmentsChange={(next) => send({ type: "SET_ATTACHMENTS", attachments: next })}
            onSend={() => send({ type: "SUBMIT" })}
            placeholder={source === "pr" ? "Add an instruction for this pull request (optional)" : source === "branch" ? "What should the agent do on this branch?" : "Message the agent, tag @files, or use /commands and /skills"}
            repo={selectedProject?.name}
            branch={source === "pr" ? selectedPr?.headRefName ?? baseBranch : baseBranch}
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
