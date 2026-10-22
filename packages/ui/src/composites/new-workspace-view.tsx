import { Tooltip } from "../components/tooltip.js"
import { Spin } from "../components/spin.js"
import * as React from "react";
import type {
  AgentEndpointCatalog,
  Environment,
  IssueSummary,
  PermissionMode,
  ProviderCatalog,
  ProviderConnectionId,
  ProviderModelId,
  Project,
  PrSummary,
  Session,
} from "@jingler/core";
import { sessionsLinkedToIssue } from "@jingler/core";
import type { SessionCreationPhase } from "@jingler/contracts";
import { useMachine } from "@xstate/react";
import {
  Check,
  CircleDot,
  Cloud,
  FolderGit2,
  GitBranch,
  GitFork,
  GitPullRequest,
  MessageCircle,
  Monitor,
  LoaderCircle,
  Server,
  SquarePen,
  X,
} from "lucide-react";
import { Button } from "../components/button.js";
import { GithubMark } from "../components/github-mark.js";
import { LinearMark } from "../components/linear-mark.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSearch,
  SelectTrigger,
} from "../components/beui/select.js";
import { cn } from "../lib/cn.js";
import type { PendingEnvironmentSession } from "../app/environment-session-startup-machine.js";
import { Composer } from "./composer.js";
import {
  AUTO_PROJECT_ID,
  newWorkspaceMachine,
  type NewSessionSource,
  type NewWorkspaceContext,
  type NewWorkspaceDeps,
  type NewWorkspaceEvent,
} from "./new-workspace-machine.js";
import { StartFromList } from "./start-from-list.js";
import { EnvironmentWakeChip, WorkspaceProvisioning, showsWakeChip } from "./workspace-provisioning.js";

interface PickerOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  keywords?: string;
  disabled?: boolean;
  icon: React.ReactNode;
}

const startupSteps = (kind: Environment["kind"]): ReadonlyArray<{
  phase: SessionCreationPhase;
  label: string;
  description: string;
}> => kind === "managed"
  ? [
      { phase: "checking-access", label: "Checking Cloud access", description: "Validating your account and selected provider connection." },
      { phase: "resolving-repository", label: "Resolving repository", description: "Pinning the selected branch to an exact commit." },
      { phase: "starting-sandbox", label: "Starting Cloud workspace", description: "Booting an isolated sandbox and cloning the repository." },
      { phase: "creating-session", label: "Creating session", description: "Connecting Jingler to the hydrated workspace." },
      { phase: "ready", label: "Ready", description: "Opening the session." }
    ]
  : [
      { phase: "checking-access", label: "Checking device access", description: "Confirming the selected device is online and compatible." },
      { phase: "resolving-repository", label: "Preparing repository", description: "Finding or cloning the repository on the device." },
      { phase: "creating-session", label: "Creating session", description: "Creating the checkout and connecting Jingler." },
      { phase: "ready", label: "Ready", description: "Opening the session." }
    ];

function EnvironmentStartupProgress({
  phase,
  error,
  environment,
  onRetry,
}: {
  phase: SessionCreationPhase | null;
  error?: string | null;
  onRetry?: () => void;
  environment: Pick<Environment, "kind" | "name">;
}) {
  const renderStartupStep = ((step, index) => {
                               function renderStartupStatus() {
                                 return (<span
                className={cn(
                  "relative z-10 mt-0.5 flex size-6 flex-none items-center justify-center rounded-full border",
                  complete
                    ? "border-green/50 bg-green/10 text-green"
                    : active
                      ? "border-blue/50 bg-blue/10 text-blue"
                      : "border-line bg-sunken text-dim",
                )}
              >
                {complete ? (
                  <Check size={13} aria-hidden />
                ) : active ? (
                  <Spin>
                    <LoaderCircle size={13} aria-hidden />
                  </Spin>
                ) : (
                  <span className="size-1 rounded-full bg-current" />
                )}
              </span>)
                               }

          const complete = index < activeIndex || phase === "ready";
          const active = index === activeIndex && phase !== "ready";
          return (
            <li
              key={step.phase}
              className="relative flex min-h-[62px] gap-3"
              data-phase={step.phase}
              data-status={
                complete ? "complete" : active ? "active" : "pending"
              }
            >
              {index < steps.length - 1 && (
                <span
                  className={cn(
                    "absolute left-[11px] top-7 h-[35px] w-px",
                    complete ? "bg-green/50" : "bg-line",
                  )}
                  aria-hidden
                />
              )}
              {renderStartupStatus()}
              <span className="min-w-0 pb-4">
                <span
                  className={cn(
                    "block text-[12.5px] font-medium",
                    complete || active ? "text-text-bright" : "text-dim",
                  )}
                >
                  {step.label}
                </span>
                <span className="mt-0.5 block text-[10.5px] text-muted-foreground">
                  {step.description}
                </span>
              </span>
            </li>
          );
        }) satisfies  Parameters<typeof steps.map>[0]

  const steps = startupSteps(environment.kind);
  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => step.phase === phase),
  );
  return (
    <section
      className="m-auto w-full max-w-[560px] rounded-2xl border border-line bg-panel p-8"
      aria-label={`${environment.name} session startup`}
      aria-live="polite"
      data-testid="environment-startup-progress"
    >
      <div className="mb-7 flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-selection text-blue">
          {environment.kind === "managed"
            ? <Cloud size={20} aria-hidden />
            : <Server size={20} aria-hidden />}
        </span>
        <div>
          <h2 className="text-[17px] font-semibold text-text-bright">
            Starting your session on {environment.name}
          </h2>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            You can switch sessions while Jingler prepares the workspace.
          </p>
        </div>
      </div>
      <ol className="flex flex-col" aria-label="Startup steps">
        {steps.map(renderStartupStep)}
      </ol>
      {error && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[11px] text-red"
        >
          {error}
        </p>
      )}
      {error && onRetry && <div className="mt-4 flex justify-end"><Button onClick={onRetry}>Retry</Button></div>}
    </section>
  );
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
  contentClassName = "w-[380px]",
}: {
  value: T | "";
  options: ReadonlyArray<PickerOption<T>>;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  disabled?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? options.filter((option) =>
        `${option.label} ${option.keywords ?? ""}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : options;

  return (
    <Select
      value={value}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      onValueChange={(next) => onValueChange(next as T)}
      disabled={disabled}
      placement="top"
      className="min-w-0"
    >
      <SelectTrigger
        ariaLabel={ariaLabel}
        className={cn(
          "h-10 min-w-0 rounded-lg border-0 bg-transparent px-2 py-0 text-[13px] shadow-none hover:bg-surface",
          triggerClassName,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected?.icon}
          <span className={cn("truncate", selected ? "text-muted-foreground" : "text-dim")}>
            {selected?.label ?? placeholder}
          </span>
        </span>
      </SelectTrigger>
      <SelectContent
        className={cn(
          "right-auto [&_ul]:max-h-[360px] [&_ul]:overflow-y-auto [&_ul]:pt-2",
          contentClassName,
        )}
        search={
          <SelectSearch
            autoFocus
            wrapperClassName="mb-2"
            placeholder={searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        }
      >
        {filtered.length === 0 ? (
          <li className="py-8 text-center text-[12px] text-muted-foreground">
            {emptyLabel}
          </li>
        ) : filtered.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            textValue={option.label}
            disabled={option.disabled}
            className="min-h-11 gap-2.5 py-2"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              {option.icon}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">
                  {option.label}
                </span>
                {option.description && (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface NewWorkspaceViewProps {
  open: boolean;
  projects: ReadonlyArray<Project>;
  environments?: ReadonlyArray<Environment>;
  /** Sessions already open, for the "Already open in …" warning. */
  sessions?: ReadonlyArray<Session>;
  /** Jumps to Settings → Plugins; enables the "<Provider> isn't connected" Connect action. */
  onConnectIssueProvider?: () => void;
  onOpenSession?: (id: string) => void;
  providerCatalog?: ProviderCatalog | null;
  agentEndpointCatalog?: AgentEndpointCatalog | null;
  defaultConnectionId?: ProviderConnectionId | null;
  defaultModelId?: ProviderModelId | null;
  defaultMode?: PermissionMode | null;
  defaultProjectId?: string | null;
  requestedProjectId?: string | null;
  requestedPr?: PrSummary | null;
  requestedIssue?: IssueSummary | null;
  /** First message to seed the New Session composer with. */
  requestedDraft?: string | null;
  prepareProject: NewWorkspaceDeps["prepareProject"];
  loadBranches: NewWorkspaceDeps["loadBranches"];
  issueProviders?: NewWorkspaceDeps["issueProviders"];
  loadPullRequests?: NewWorkspaceDeps["loadPullRequests"];
  loadGithubIssues?: NewWorkspaceDeps["loadGithubIssues"];
  loadProviderIssues?: NewWorkspaceDeps["loadProviderIssues"];
  onCreate: NewWorkspaceDeps["onCreate"];
  onCreateFromPr?: NewWorkspaceDeps["onCreateFromPr"];
  onCreateFromIssue?: NewWorkspaceDeps["onCreateFromIssue"];
  /** App-owned remote startup state survives navigation away from this view. */
  environmentStartup?: PendingEnvironmentSession | null;
  /** Resumes a paused managed environment, or retries a failed one. */
  onWakeEnvironment?: (environmentId: string) => void;
  onAddProject?: () => void;
  onImportSessions?: () => void;
  onClose: () => void;
}

const startupEnvironment = (startup: PendingEnvironmentSession | null | undefined, selected: Environment | undefined) =>
  startup == null ? selected! : { kind: startup.environmentKind, name: startup.environmentName }
const modelSelectionError = (complete: boolean, hasSelectableModel: boolean) =>
  complete ? undefined : hasSelectableModel
    ? "Choose an agent runtime and model."
    : "Connect a provider in Settings › Provider connections to choose a model."

const contentUnavailableReason = (source: NewSessionSource, hasPr: boolean, hasIssue: boolean, projectId: string, baseBranch: string) => {
  if (source === "pr" && !hasPr) return "Choose a pull request before starting."
  if ((source === "github" || source.startsWith("provider:")) && !hasIssue) return "Choose an issue before starting."
  return projectId && baseBranch ? undefined : "Choose a project and branch before starting."
}
const workspacePrompt = (source: NewSessionSource) => source === "pr"
  ? "Add an instruction for this pull request (optional)"
  : source === "branch" ? "What should the agent do on this branch?" : "Message the agent, tag @files, or use /commands and /skills"
const selectedBranch = (source: NewSessionSource, prBranch: string | undefined, baseBranch: string) => source === "pr" ? (prBranch ?? baseBranch) : baseBranch
const selectedBranchOption = (source: NewSessionSource, prBranch: string | undefined, baseBranch: string) => source === "pr" ? (prBranch ?? "") : baseBranch
const remoteEnvironmentId = (environmentId: string) => environmentId === "local" ? undefined : environmentId
const branchPlaceholder = (loading: boolean, local: boolean) => loading ? (local ? "Loading branches…" : "Preparing on host…") : "Choose branch"

const workspaceUnavailableReason = (loading: boolean, localOrManaged: boolean, hasProjects: boolean, modelReason: string | undefined, contentReason: () => string | undefined) => {
  if (loading) return localOrManaged ? "Loading branches…" : "Preparing project on host…"
  if (!hasProjects) return "Add a project before starting a session."
  return modelReason ?? contentReason()
}

type WorkspaceSend = (event: NewWorkspaceEvent) => void
function ProjectControls({ context, projectOptions, sourceOptions, checkoutOptions, branchOptions, loading, send }: {
  context: NewWorkspaceContext; projectOptions: ReadonlyArray<PickerOption<string>>; sourceOptions: ReadonlyArray<PickerOption<NewSessionSource>>
  checkoutOptions: ReadonlyArray<PickerOption<"worktree" | "direct">>; branchOptions: ReadonlyArray<PickerOption<string>>; loading: boolean; send: WorkspaceSend
}) {
  const { projectId, source, isolation, selectedPr, baseBranch, environmentId } = context
  const auto = projectId === AUTO_PROJECT_ID
  return <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
    <div className="min-w-[130px] flex-1"><SearchPicker value={projectId} options={projectOptions} onValueChange={(value) => send({ type: "SET_PROJECT", projectId: value })} ariaLabel="Project" placeholder="Choose project" searchPlaceholder="Search projects…" emptyLabel="No projects match." disabled={loading} triggerClassName="h-8 w-full px-2 text-[11.5px]" contentClassName="w-[340px]" /></div>
    <div className="min-w-[130px] flex-1"><SearchPicker value={source} options={sourceOptions} onValueChange={(value) => send({ type: "SET_SOURCE", source: value })} ariaLabel="Session source" placeholder="Start from" searchPlaceholder="Search session sources…" emptyLabel="No session sources match." disabled={loading} triggerClassName="h-8 w-full px-2 text-[11.5px]" contentClassName="w-[300px]" /></div>
    {!auto && <div className="min-w-[130px] flex-1"><SearchPicker value={isolation} options={checkoutOptions} onValueChange={(value) => send({ type: "SET_ISOLATION", isolation: value })} ariaLabel="Checkout" placeholder="Choose checkout" searchPlaceholder="Search checkout modes…" emptyLabel="No checkout modes match." disabled={loading} triggerClassName="h-8 w-full px-2 text-[11.5px]" contentClassName="w-[300px]" /></div>}
    {!auto && <div className="min-w-[130px] flex-1"><SearchPicker value={selectedBranchOption(source, selectedPr?.headRefName, baseBranch)} options={branchOptions} onValueChange={(value) => send({ type: "SET_BASE", baseBranch: value })} ariaLabel="Base branch" placeholder={branchPlaceholder(loading, environmentId === "local")} searchPlaceholder="Search branches…" emptyLabel="No branches match." disabled={loading || source === "pr"} triggerClassName="h-8 w-full px-2 text-[11.5px]" contentClassName="w-[320px]" /></div>}
  </div>
}
function WorkspaceComposer({ submitting, context, props, catalog, unavailableReason, controls, selectedProject, send }: {
  submitting: boolean; context: NewWorkspaceContext; props: NewWorkspaceViewProps; catalog: AgentEndpointCatalog | null | undefined
  unavailableReason: string | undefined; controls: React.ReactNode; selectedProject: Project | undefined; send: WorkspaceSend
}) {
  const { draft, attachments, source, selectedPr, baseBranch, environmentId, connectionId, providerId, modelId, mode, reasoning } = context
  return <Composer submitting={submitting} preserveDraftOnSend autoFocus focusKey="new-session" value={draft} onValueChange={(value) => send({ type: "SET_DRAFT", draft: value })} attachments={attachments} onAttachmentsChange={(next) => send({ type: "SET_ATTACHMENTS", attachments: next })} onSend={() => send({ type: "SUBMIT" })} placeholder={workspacePrompt(source)} repo={selectedProject?.name} branch={selectedBranch(source, selectedPr?.headRefName, baseBranch)} environments={props.environments} environmentId={remoteEnvironmentId(environmentId)} onSetEnvironment={(props.environments?.length ?? 0) > 0 ? (value) => send({ type: "SET_ENVIRONMENT", environmentId: value ?? "local" }) : undefined} providerCatalog={props.providerCatalog} agentEndpointCatalog={catalog} endpointId={context.endpointId} connectionId={connectionId} providerId={providerId} modelId={modelId} onSetModel={(selection) => send({ type: "SET_MODEL", ...selection })} mode={mode} onSetMode={(value) => send({ type: "SET_MODE", mode: value })} reasoningEffort={reasoning?.effort} thinkingEnabled={reasoning?.enabled} onSetReasoning={(value) => send({ type: "SET_REASONING", reasoning: value })} allowPlan disabledReason={unavailableReason} contextControls={controls} />
}

function WorkspaceStartFrom({ props, context, send, icon, label, loading }: {
  props: NewWorkspaceViewProps; context: NewWorkspaceContext; send: WorkspaceSend; icon: React.ReactNode; label: string; loading: boolean
}) {
  const { source, search, mine, pullRequests, issues, selectedPr, selectedIssue, sourceError } = context
  if (source === "blank" || source === "branch") return null
  const providerConnected = !source.startsWith("provider:") || (props.issueProviders ?? []).some((provider) => `provider:${provider.id}` === source)
  const linkedSessions = selectedIssue ? sessionsLinkedToIssue(props.sessions ?? [], selectedIssue) : []
  return <StartFromList kind={source === "pr" ? "pr" : "issue"} icon={icon} label={label} search={search} mine={mine} pullRequests={pullRequests} issues={issues} selectedPr={selectedPr?.number ?? null} selectedIssue={selectedIssue?.id ?? null} loading={loading} error={sourceError} providerConnected={providerConnected} linkedSessions={linkedSessions} onSearch={(value) => send({ type: "SET_SEARCH", search: value })} onMine={() => send({ type: "SET_MINE", mine: !mine })} onRetry={() => send({ type: "RETRY_SOURCE" })} onConnect={props.onConnectIssueProvider} onOpenSession={props.onOpenSession} onPr={(pr) => send({ type: "SELECT_PR", pr })} onIssue={(issue) => send({ type: "SELECT_ISSUE", issue })} />
}

function ProgressPane({ props, context, send, startup, failed, environment }: {
  props: NewWorkspaceViewProps; context: NewWorkspaceContext; send: WorkspaceSend; startup: boolean; failed: boolean; environment: Environment | undefined
}) {
  const { provisioningPhase, failedPhase, error } = context
  if (startup) return <EnvironmentStartupProgress phase={props.environmentStartup?.phase ?? provisioningPhase} error={props.environmentStartup?.error} environment={startupEnvironment(props.environmentStartup, environment)} onRetry={() => send({ type: "RETRY_PROVISION" })} />
  return <WorkspaceProvisioning phase={provisioningPhase} failedPhase={failed ? (failedPhase ?? provisioningPhase) : null} error={error} onCancel={() => send({ type: "CANCEL_PROVISION" })} onRetry={() => send({ type: "RETRY_PROVISION" })} onEdit={() => send({ type: "EDIT_AFTER_FAILURE" })} />
}

function WakeChip({ environment, onWake }: { environment: Environment | undefined; onWake?: (environmentId: string) => void }) {
  if (environment?.kind !== "managed" || !showsWakeChip(environment.state)) return null
  return <EnvironmentWakeChip state={environment.state} onWake={onWake && (() => onWake(environment.id))} />
}

function NewWorkspaceContent({ props, context, send, submitting, failed, loading, sourceLoading, selectedEnvironment, selectedSource, sourceLabel, catalog, unavailableReason, selectedProject, projectOptions, sourceOptions, checkoutOptions, branchOptions }: {
  props: NewWorkspaceViewProps; context: NewWorkspaceContext; send: WorkspaceSend; submitting: boolean; failed: boolean; loading: boolean; sourceLoading: boolean
  selectedEnvironment: Environment | undefined; selectedSource: PickerOption<NewSessionSource> | undefined; sourceLabel: string
  catalog: AgentEndpointCatalog | null | undefined; unavailableReason: string | undefined; selectedProject: Project | undefined
  projectOptions: ReadonlyArray<PickerOption<string>>; sourceOptions: ReadonlyArray<PickerOption<NewSessionSource>>
  checkoutOptions: ReadonlyArray<PickerOption<"worktree" | "direct">>; branchOptions: ReadonlyArray<PickerOption<string>>
}) {
  const { source, search, mine, pullRequests, issues, selectedPr, selectedIssue, draft, provisioningPhase, error } = context
  const startup = props.environmentStartup || (submitting && selectedEnvironment !== undefined)
  return <div className="flex min-h-0 flex-1 flex-col bg-editor" data-testid="new-session-view">
    <div className="flex h-12 flex-none items-center border-b border-hairline px-5"><h1 className="text-[13px] font-semibold text-text-bright">New session</h1><span className="flex-1" /><WakeChip environment={selectedEnvironment} onWake={props.onWakeEnvironment} /><Button variant="ghost" size="icon" aria-label="Close new session" disabled={submitting && !props.environmentStartup?.error} onClick={() => send({ type: "CLOSE" })}><X size={15} /></Button></div>
    <div className="flex min-h-0 flex-1 overflow-auto px-6 py-10">{startup || submitting || failed
      ? <ProgressPane props={props} context={context} send={send} startup={Boolean(startup)} failed={failed} environment={selectedEnvironment} />
      : <div className="m-auto flex w-full max-w-[1040px] flex-col gap-6">
          <div className="flex items-center gap-3"><div><h2 className="text-[20px] font-semibold tracking-[-0.2px] text-text-bright">What are we working on?</h2><p className="mt-1 max-w-[62ch] text-pretty text-[12px] leading-relaxed text-muted-foreground">Choose where the work starts, configure its checkout, then send the first message.</p></div><span className="flex-1" />{props.onAddProject && <Button variant="secondary" onClick={props.onAddProject}><FolderGit2 size={14} /> Add project</Button>}</div>
          <WorkspaceStartFrom props={props} context={context} send={send} icon={selectedSource?.icon} label={sourceLabel} loading={sourceLoading} />
          {source === "branch" && <p className="rounded-lg border border-line bg-sunken px-3 py-2 text-[11px] text-muted-foreground">The selected branch will be checked out directly in the session worktree; Jingler will not create a replacement task branch.</p>}
          <label className="text-xs text-text-bright">
            <Tooltip
              label="Enable checkpoint-safe mode before the first turn. Local isolated managed Pi only; structured edits and read-only inspection. File rename is unsupported in safe mode; no files are changed. Shell/build/test, setup commands, terminals, delegation and offload are blocked."
              className="max-w-sm whitespace-normal"
            >
              <input type="checkbox" aria-label="Checkpoint-safe mode" disabled={loading || submitting} checked={context.checkpointSafeMode} onChange={(event) => send({ type: "SET_CHECKPOINT_SAFE_MODE", enabled: event.currentTarget.checked })} />
            </Tooltip>{" "}
            Checkpoint-safe mode
          </label>
          <WorkspaceComposer submitting={submitting} context={context} props={props} catalog={catalog} unavailableReason={unavailableReason} selectedProject={selectedProject} send={send} controls={<ProjectControls context={context} projectOptions={projectOptions} sourceOptions={sourceOptions} checkoutOptions={checkoutOptions} branchOptions={branchOptions} loading={loading} send={send} />} />
          {draft.trim().length === 0 && unavailableReason === undefined && <div className="flex justify-end"><Button variant="secondary" aria-label="Create workspace" onClick={() => send({ type: "SUBMIT" })}><MessageCircle size={14} /> Create without a first message</Button></div>}
          {error && <p role="alert" className="text-[11px] text-red">{error}</p>}
        </div>}
    </div>
  </div>
}

const endpointCatalogForEnvironment = (catalog: AgentEndpointCatalog | null | undefined, environmentId: string, environment: Environment | undefined) => {
  const targetId = environmentId === "local" ? "desktop" : (environment?.capabilities.runtime?.targetId ?? environmentId)
  const endpoints = catalog?.endpoints.filter(({ endpoint }) => endpoint.targetId === targetId) ?? []
  if (environment?.kind === "managed" && endpoints.length === 0) return null
  return catalog == null ? catalog : { ...catalog, endpoints }
}

const sourceOptionsFor = (props: NewWorkspaceViewProps): ReadonlyArray<{
    value: NewSessionSource;
    label: string;
    description: string;
    icon: React.ReactNode;
  }> => [
    {
      value: "blank",
      label: "New task",
      description: "Start from a base branch",
      icon: <SquarePen size={15} className="text-muted-foreground" />,
    },
    {
      value: "branch",
      label: "Existing branch",
      description: "Continue work already started",
      icon: <GitBranch size={15} className="text-muted-foreground" />,
    },
    ...(props.loadPullRequests
      ? [
          {
            value: "pr" as const,
            label: "Pull request",
            description: "Work on an open GitHub PR",
            icon: <GitPullRequest size={15} className="text-muted-foreground" />,
          },
        ]
      : []),
    ...(props.loadGithubIssues
      ? [
          {
            value: "github" as const,
            label: "GitHub issue",
            description: "Link and prefill from GitHub",
            icon: <GithubMark className="size-[15px] text-muted-foreground" />,
          },
        ]
      : []),
    ...(props.issueProviders ?? []).map((provider) => ({
      value: `provider:${provider.id}` as const,
      label: `${provider.label} issue`,
      description: `Link and prefill from ${provider.label}`,
      icon:
        provider.id === "linear" ? (
          <LinearMark className="size-[15px] text-muted-foreground" />
        ) : (
          <CircleDot size={15} className="text-muted-foreground" />
        ),
    })),
    ...(props.onConnectIssueProvider && !(props.issueProviders ?? []).some((provider) => provider.id === "linear")
      ? [{ value: "provider:linear" as const, label: "Linear issue", description: "Connect Linear to link issues", icon: <LinearMark className="size-[15px] text-muted-foreground" /> }]
      : []),
  ];

export function NewWorkspaceView(props: NewWorkspaceViewProps) {
  const depsRef = React.useRef<NewWorkspaceDeps>(props);
  depsRef.current = props;
  const getDeps = React.useCallback(() => depsRef.current, []);
  const [state, send] = useMachine(newWorkspaceMachine, { input: { getDeps } });

  React.useEffect(() => {
    if (props.open)
      send({
        type: "OPEN",
        ...(props.requestedProjectId
          ? { projectId: props.requestedProjectId }
          : {}),
        ...(props.requestedPr ? { pr: props.requestedPr } : {}),
        ...(props.requestedIssue ? { issue: props.requestedIssue } : {}),
        ...(props.requestedDraft ? { draft: props.requestedDraft } : {}),
      });
    else send({ type: "CLOSE" });
  }, [props.open, props.requestedPr, props.requestedIssue, props.requestedProjectId, props.requestedDraft, send]);

  const projectRequest = props.requestedProjectId ?? props.defaultProjectId;
  const previousProjectRequest = React.useRef(projectRequest);
  React.useEffect(() => {
    const changed = previousProjectRequest.current !== projectRequest;
    previousProjectRequest.current = projectRequest;
    if (props.open && projectRequest && changed) {
      send({ type: "SET_PROJECT", projectId: projectRequest });
    }
  }, [projectRequest, props.open, send]);

  React.useEffect(() => {
    if (!props.open || state.matches("closed") || state.context.projectId !== "") return;
    const project = props.projects.find((candidate) => candidate.id === projectRequest) ??
      props.projects.find((candidate) => candidate.availability === "available");
    if (project) send({ type: "SET_PROJECT", projectId: project.id });
  }, [props.open, props.projects, projectRequest, send, state]);

  React.useEffect(() => {
    if (props.open) send({ type: "SYNC_MODELS" });
  }, [
    props.open,
    props.providerCatalog,
    props.agentEndpointCatalog,
    props.defaultConnectionId,
    props.defaultModelId,
    send,
  ]);

  const {
    projectId,
    environmentId,
    baseBranch,
    branches,
    source,
    selectedPr,
    selectedIssue,
    runtimeId,
    endpointId,
    providerId,
    modelId,
  } = state.context;
  const selectedProject = props.projects.find(
    (project) => project.id === projectId,
  );
  const selectedEnvironment = props.environments?.find(
    (environment) => environment.id === environmentId,
  );
  const agentEndpointCatalog = endpointCatalogForEnvironment(props.agentEndpointCatalog, environmentId, selectedEnvironment)
  const submitting = state.matches("submitting");
  const loading = state.matches("loading");
  const sourceLoading = state.matches("sourceLoading");
  const hasSelectableModel =
    props.providerCatalog?.connections.some(({ models }) =>
      models.some((model) => model.selectable),
    ) === true;
  const modelUnavailableReason = modelSelectionError(
    runtimeId !== null && endpointId !== null && providerId !== null && modelId !== null,
    hasSelectableModel,
  );
  const unavailableReason = workspaceUnavailableReason(
    loading,
    environmentId === "local" || selectedEnvironment?.kind === "managed",
    props.projects.length > 0,
    modelUnavailableReason,
    () => projectId === AUTO_PROJECT_ID
      ? (source === "blank" ? undefined : "Auto only supports a new task.")
      : contentUnavailableReason(source, selectedPr !== null, selectedIssue !== null, projectId, baseBranch),
  );

  const projectOptions: ReadonlyArray<PickerOption<string>> = [
    {
      value: AUTO_PROJECT_ID,
      label: "Auto",
      description: "Start with no repo; the agent attaches one as it works",
      icon: (
        <SquarePen size={16} className="flex-none text-muted-foreground" aria-hidden />
      ),
    },
    ...props.projects.map((project) => ({
      value: project.id,
      label: project.name,
      description:
        project.availability === "available"
          ? project.path
          : "Unavailable on this host",
      keywords: project.path,
      disabled: project.availability !== "available",
      icon: (
        <FolderGit2 size={16} className="flex-none text-muted-foreground" aria-hidden />
      ),
    })),
  ];
  const checkoutOptions: ReadonlyArray<PickerOption<"worktree" | "direct">> = [
    {
      value: "worktree",
      label: "Worktree",
      description: "Create an isolated Git worktree",
      keywords: "new isolated branch",
      icon: <GitFork size={16} className="flex-none text-muted-foreground" aria-hidden />,
    },
    {
      value: "direct",
      label: "Local",
      description: "Use the existing project checkout",
      keywords: "host direct checkout",
      icon: (
        <Monitor
          size={16}
          className="flex-none text-muted-foreground"
          aria-hidden
        />
      ),
    },
  ];
  const branchOptions: ReadonlyArray<PickerOption<string>> = branches.map(
    (branch) => ({
      value: branch,
      label: branch,
      keywords: branch.replaceAll("/", " "),
      icon: <GitBranch size={16} className="flex-none text-muted-foreground" aria-hidden />,
    }),
  );
  const sourceOptions = sourceOptionsFor(props);
  const selectedSource = sourceOptions.find(
    (option) => option.value === source,
  );
  const sourceLabel = selectedSource?.label ?? "issue";

  return <NewWorkspaceContent
    props={props}
    context={state.context}
    send={send}
    submitting={submitting}
    failed={state.matches("failed")}
    loading={loading}
    sourceLoading={sourceLoading}
    selectedEnvironment={selectedEnvironment}
    selectedSource={selectedSource}
    sourceLabel={sourceLabel}
    catalog={agentEndpointCatalog}
    unavailableReason={unavailableReason}
    selectedProject={selectedProject}
    projectOptions={projectOptions}
    sourceOptions={sourceOptions}
    checkoutOptions={checkoutOptions}
    branchOptions={branchOptions}
  />;
}
