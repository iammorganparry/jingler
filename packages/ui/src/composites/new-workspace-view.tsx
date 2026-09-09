import * as React from "react";
import type {
  Environment,
  PermissionMode,
  ProviderCatalog,
  ProviderConnectionId,
  ProviderModelId,
  Project,
  PrSummary,
} from "@jingler/core";
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
import { SearchInput } from "../components/search-input.js";
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
import { IssuePickerList } from "./issue-picker-list.js";
import {
  newWorkspaceMachine,
  type NewSessionSource,
  type NewWorkspaceDeps,
} from "./new-workspace-machine.js";
import { PrPickerList } from "./pr-picker-list.js";

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
}: {
  phase: SessionCreationPhase | null;
  error?: string | null;
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
                  <LoaderCircle
                    size={13}
                    className="animate-spin"
                    aria-hidden
                  />
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
  providerCatalog?: ProviderCatalog | null;
  defaultConnectionId?: ProviderConnectionId | null;
  defaultModelId?: ProviderModelId | null;
  defaultMode?: PermissionMode | null;
  defaultProjectId?: string | null;
  requestedProjectId?: string | null;
  requestedPr?: PrSummary | null;
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
  onAddProject?: () => void;
  onClose: () => void;
}

export function NewWorkspaceView(props: NewWorkspaceViewProps) {
  function renderStartupProgress() {
    return (<EnvironmentStartupProgress
            phase={props.environmentStartup?.phase ?? provisioningPhase}
            error={props.environmentStartup?.error}
            environment={props.environmentStartup === undefined || props.environmentStartup === null
              ? selectedEnvironment!
              : {
                  kind: props.environmentStartup.environmentKind,
                  name: props.environmentStartup.environmentName
                }}
          />)
  }

         function getModelSelectionError() {
           return (connectionId === null || providerId === null || modelId === null
      ? hasSelectableModel
        ? "Choose a provider connection and model."
        : "Connect a provider in Settings › Provider connections to choose a model."
      : undefined)
         }

  function renderWorkspaceComposer() {
    return (<Composer
              autoFocus
              focusKey="new-session"
              value={draft}
              onValueChange={(value) =>
                send({ type: "SET_DRAFT", draft: value })
              }
              attachments={attachments}
              onAttachmentsChange={(next) =>
                send({ type: "SET_ATTACHMENTS", attachments: next })
              }
              onSend={() => send({ type: "SUBMIT" })}
              placeholder={
                source === "pr"
                  ? "Add an instruction for this pull request (optional)"
                  : source === "branch"
                    ? "What should the agent do on this branch?"
                    : "Message the agent, tag @files, or use /commands and /skills"
              }
              repo={selectedProject?.name}
              branch={
                source === "pr"
                  ? (selectedPr?.headRefName ?? baseBranch)
                  : baseBranch
              }
              environments={props.environments}
              environmentId={
                environmentId === "local" ? undefined : environmentId
              }
              onSetEnvironment={(value) =>
                send({
                  type: "SET_ENVIRONMENT",
                  environmentId: value ?? "local",
                })
              }
              providerCatalog={props.providerCatalog}
              connectionId={connectionId}
              modelId={modelId}
              onSetModel={({
                connectionId: nextConnection,
                providerId: nextProvider,
                modelId: nextModel,
              }) =>
                send({
                  type: "SET_MODEL",
                  connectionId: nextConnection,
                  providerId: nextProvider,
                  modelId: nextModel,
                })
              }
              mode={mode}
              onSetMode={(value) => send({ type: "SET_MODE", mode: value })}
              reasoningEffort={reasoning?.effort}
              thinkingEnabled={reasoning?.enabled}
              onSetReasoning={(value) =>
                send({ type: "SET_REASONING", reasoning: value })
              }
              allowPlan
              disabledReason={unavailableReason}
              contextControls={
                renderProjectControls()
              }
            />)
  }

         function renderProjectControls() {
           return (<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  <div className="min-w-[130px] flex-1">
                    <SearchPicker
                      value={projectId}
                      options={projectOptions}
                      onValueChange={(value) =>
                        send({ type: "SET_PROJECT", projectId: value })
                      }
                      ariaLabel="Project"
                      placeholder="Choose project"
                      searchPlaceholder="Search projects…"
                      emptyLabel="No projects match."
                      disabled={loading}
                      triggerClassName="h-8 w-full px-2 text-[11.5px]"
                      contentClassName="w-[340px]"
                    />
                  </div>
                  <div className="min-w-[130px] flex-1">
                    <SearchPicker
                      value={source}
                      options={sourceOptions}
                      onValueChange={(value) =>
                        send({ type: "SET_SOURCE", source: value })
                      }
                      ariaLabel="Session source"
                      placeholder="Start from"
                      searchPlaceholder="Search session sources…"
                      emptyLabel="No session sources match."
                      disabled={loading}
                      triggerClassName="h-8 w-full px-2 text-[11.5px]"
                      contentClassName="w-[300px]"
                    />
                  </div>
                  <div className="min-w-[130px] flex-1">
                    <SearchPicker
                      value={isolation}
                      options={checkoutOptions}
                      onValueChange={(value) =>
                        send({ type: "SET_ISOLATION", isolation: value })
                      }
                      ariaLabel="Checkout"
                      placeholder="Choose checkout"
                      searchPlaceholder="Search checkout modes…"
                      emptyLabel="No checkout modes match."
                      disabled={loading}
                      triggerClassName="h-8 w-full px-2 text-[11.5px]"
                      contentClassName="w-[300px]"
                    />
                  </div>
                  <div className="min-w-[130px] flex-1">
                    <SearchPicker
                      value={
                        source === "pr"
                          ? (selectedPr?.headRefName ?? "")
                          : baseBranch
                      }
                      options={branchOptions}
                      onValueChange={(value) =>
                        send({ type: "SET_BASE", baseBranch: value })
                      }
                      ariaLabel="Base branch"
                      placeholder={
                        loading
                          ? environmentId === "local"
                            ? "Loading branches…"
                            : "Preparing on host…"
                          : "Choose branch"
                      }
                      searchPlaceholder="Search branches…"
                      emptyLabel="No branches match."
                      disabled={loading || source === "pr"}
                      triggerClassName="h-8 w-full px-2 text-[11.5px]"
                      contentClassName="w-[320px]"
                    />
                  </div>
                </div>)
         }

function getContent() {
             if (source === "pr" && selectedPr === null) return ("Choose a pull request before starting.")
             if ((source === "github" || source.startsWith("provider:")) &&
                selectedIssue === null) return ("Choose an issue before starting.")
             if (!projectId || !baseBranch) return ("Choose a project and branch before starting.")
             return (undefined)
           }

         function renderSourcePicker() {
           return (source !== "blank" && source !== "branch" && (
              <section
                className="overflow-hidden rounded-xl border border-line bg-panel"
                aria-label="Source picker"
              >
                <header className="flex items-center gap-2 border-b border-line px-4 py-3">
                  <span className="text-text-bright">
                    {selectedSource?.icon}
                  </span>
                  <h3 className="text-[12px] font-semibold text-text-bright">
                    {sourceLabel}s
                  </h3>
                  <span className="text-[10.5px] text-dim">
                    Choose one to prefill this session
                  </span>
                </header>
                <div className="flex items-center gap-2 px-3 pt-3">
                  <SearchInput
                    value={search}
                    onChange={(value) =>
                      send({ type: "SET_SEARCH", search: value })
                    }
                    placeholder={
                      source === "pr"
                        ? "Search pull requests…"
                        : `Search ${sourceLabel.toLowerCase()}s…`
                    }
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
                      onSelect={(issue) =>
                        send({ type: "SELECT_ISSUE", issue })
                      }
                      loading={sourceLoading}
                    />
                  )}
                </div>
              </section>
            ))
         }

         function getUnavailableReason() {


           if (submitting) return ("Creating session…")
           if (loading) return (environmentId === "local" || selectedEnvironment?.kind === "managed"
        ? "Loading branches…"
        : "Preparing project on host…")
           if (props.projects.length === 0) return ("Add a project before starting a session.")
           return (modelUnavailableReason ??
          (getContent()))
         }

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
      });
    else send({ type: "CLOSE" });
  }, [props.open, props.requestedPr, props.requestedProjectId, send]);

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
    if (!props.open || state.context.projectId !== "") return;
    const project = props.projects.find(
      (candidate) => candidate.availability === "available",
    );
    if (project) send({ type: "SET_PROJECT", projectId: project.id });
  }, [props.open, props.projects, send, state.context.projectId]);

  React.useEffect(() => {
    if (props.open) send({ type: "SYNC_MODELS" });
  }, [
    props.open,
    props.providerCatalog,
    props.defaultConnectionId,
    props.defaultModelId,
    send,
  ]);

  const {
    projectId,
    environmentId,
    isolation,
    baseBranch,
    branches,
    source,
    search,
    mine,
    pullRequests,
    issues,
    selectedPr,
    selectedIssue,
    draft,
    attachments,
    mode,
    reasoning,
    connectionId,
    providerId,
    modelId,
    provisioningPhase,
    error,
  } = state.context;
  const selectedProject = props.projects.find(
    (project) => project.id === projectId,
  );
  const selectedEnvironment = props.environments?.find(
    (environment) => environment.id === environmentId,
  );
  const submitting = state.matches("submitting");
  const loading = state.matches("loading");
  const sourceLoading = state.matches("sourceLoading");
  const hasSelectableModel =
    props.providerCatalog?.connections.some(({ models }) =>
      models.some((model) => model.selectable),
    ) === true;
  const modelUnavailableReason =
    getModelSelectionError();
  const unavailableReason = getUnavailableReason();

  const projectOptions: ReadonlyArray<PickerOption<string>> =
    props.projects.map((project) => ({
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
    }));
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
  const sourceOptions: ReadonlyArray<{
    value: NewSessionSource;
    label: string;
    description: string;
    icon: React.ReactNode;
  }> = [
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
  ];
  const selectedSource = sourceOptions.find(
    (option) => option.value === source,
  );
  const sourceLabel = selectedSource?.label ?? "issue";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-editor"
      data-testid="new-session-view"
    >
      <div className="flex h-12 flex-none items-center border-b border-hairline px-5">
        <h1 className="text-[13px] font-semibold text-text-bright">
          New session
        </h1>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close new session"
          disabled={submitting && !props.environmentStartup?.error}
          onClick={() => send({ type: "CLOSE" })}
        >
          <X size={15} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto px-6 py-10">
        {props.environmentStartup || (submitting && selectedEnvironment !== undefined) ? (
          renderStartupProgress()
        ) : (
          <div className="m-auto flex w-full max-w-[1040px] flex-col gap-6">
            <div className="flex items-center gap-3">
              <div>
                <h2 className="text-[20px] font-semibold tracking-[-0.2px] text-text-bright">
                  What are we working on?
                </h2>
                <p className="mt-1 max-w-[62ch] text-pretty text-[12px] leading-relaxed text-muted-foreground">
                  Choose where the work starts, configure its checkout, then
                  send the first message.
                </p>
              </div>
              <span className="flex-1" />
              {props.onAddProject && (
                <Button variant="secondary" onClick={props.onAddProject}>
                  <FolderGit2 size={14} /> Add project
                </Button>
              )}
            </div>
            {renderSourcePicker()}

            {source === "branch" && (
              <p className="rounded-lg border border-line bg-sunken px-3 py-2 text-[11px] text-muted-foreground">
                The selected branch will be checked out directly in the session
                worktree; Jingler will not create a replacement task branch.
              </p>
            )}

            {renderWorkspaceComposer()}
            {draft.trim().length === 0 && unavailableReason === undefined && (
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  aria-label="Create workspace"
                  onClick={() => send({ type: "SUBMIT" })}
                >
                  <MessageCircle size={14} /> Create without a first message
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-[11px] text-red">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
