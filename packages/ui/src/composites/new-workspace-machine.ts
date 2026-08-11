import type {
  Attachment,
  CliInfo,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  Environment,
  HarnessCapability,
  IssueProviderDescriptor,
  IssueSummary,
  PermissionMode,
  PrSummary,
  ProvidersConfig,
  Project,
  ReasoningSetting
} from "@jingler/core"
import type { SessionCreationPhase } from "@jingler/contracts"
import { defaultModeFor, newSessionCli } from "@jingler/core"
import { assign, fromCallback, fromPromise, setup } from "xstate"

export type NewSessionSource = "blank" | "branch" | "pr" | "github" | `provider:${string}`

export interface NewWorkspaceDeps {
  projects: ReadonlyArray<Project>
  environments?: ReadonlyArray<Environment>
  clis: ReadonlyArray<CliInfo>
  capabilities: ReadonlyArray<HarnessCapability>
  issueProviders?: ReadonlyArray<IssueProviderDescriptor>
  defaultCli?: CliKind | null
  defaultModel?: string | null
  providers?: ProvidersConfig | null
  defaultProjectId?: string | null
  loadBranches: (path: string, environmentId?: string) => Promise<ReadonlyArray<string>>
  prepareProject: (projectId: string, environmentId?: string) => Promise<Project>
  loadPullRequests?: (project: Project, search: string, mine: boolean) => Promise<ReadonlyArray<PrSummary>>
  loadGithubIssues?: (project: Project, search: string, mine: boolean) => Promise<ReadonlyArray<IssueSummary>>
  loadProviderIssues?: (providerId: string, project: Project, search: string, mine: boolean) => Promise<ReadonlyArray<IssueSummary>>
  onCreate: (input: CreateSessionInput, images: ReadonlyArray<Attachment>, onProgress?: (phase: SessionCreationPhase) => void) => Promise<void>
  onCreateFromPr?: (input: CreateSessionFromPrInput, images: ReadonlyArray<Attachment>, onProgress?: (phase: SessionCreationPhase) => void) => Promise<void>
  onCreateFromIssue?: (input: CreateSessionFromIssueInput, images: ReadonlyArray<Attachment>, onProgress?: (phase: SessionCreationPhase) => void) => Promise<void>
  onClose: () => void
}

export interface NewWorkspaceContext {
  getDeps: () => NewWorkspaceDeps
  projectId: string
  environmentId: string
  resolvedProject: Project | null
  isolation: "worktree" | "direct"
  baseBranch: string
  branches: ReadonlyArray<string>
  source: NewSessionSource
  search: string
  mine: boolean
  pullRequests: ReadonlyArray<PrSummary>
  issues: ReadonlyArray<IssueSummary>
  selectedPr: PrSummary | null
  selectedIssue: IssueSummary | null
  draft: string
  attachments: ReadonlyArray<Attachment>
  cli: CliKind | ""
  model: string
  mode: PermissionMode
  reasoning?: ReasoningSetting
  provisioningPhase: SessionCreationPhase | null
  error: string | null
}

type NewWorkspaceEvent =
  | { type: "OPEN"; projectId?: string }
  | { type: "CLOSE" }
  | { type: "SET_PROJECT"; projectId: string }
  | { type: "SET_ENVIRONMENT"; environmentId: string }
  | { type: "SET_ISOLATION"; isolation: "worktree" | "direct" }
  | { type: "SET_BASE"; baseBranch: string }
  | { type: "SET_SOURCE"; source: NewSessionSource }
  | { type: "SET_SEARCH"; search: string }
  | { type: "SET_MINE"; mine: boolean }
  | { type: "SELECT_PR"; pr: PrSummary }
  | { type: "SELECT_ISSUE"; issue: IssueSummary }
  | { type: "SET_DRAFT"; draft: string }
  | { type: "SET_ATTACHMENTS"; attachments: ReadonlyArray<Attachment> }
  | { type: "SET_HARNESS"; cli: CliKind; model: string }
  | { type: "SET_MODE"; mode: PermissionMode }
  | { type: "SET_REASONING"; reasoning?: ReasoningSetting }
  | { type: "SYNC_HARNESSES" }
  | { type: "SUBMIT" }
  | { type: "PROVISION_PROGRESS"; phase: SessionCreationPhase }
  | { type: "PROVISION_DONE" }
  | { type: "PROVISION_FAILED"; error: unknown }

const projectFor = (context: NewWorkspaceContext): Project | undefined =>
  context.getDeps().projects.find((project) => project.id === context.projectId)

const preferredBranch = (branches: ReadonlyArray<string>): string =>
  branches.find((branch) => branch === "main") ??
  branches.find((branch) => branch === "master") ??
  branches[0] ?? ""

const harnessSelection = (
  deps: NewWorkspaceDeps,
  currentCli: CliKind | "" = "",
  currentModel = ""
): { cli: CliKind | ""; model: string } => {
  const preferredCli = newSessionCli(deps.clis, deps.defaultCli)
  const capability =
    deps.capabilities.find((candidate) => candidate.cli === currentCli) ??
    deps.capabilities.find((candidate) => candidate.cli === preferredCli) ??
    deps.capabilities[0]
  if (capability === undefined) return { cli: preferredCli ?? "", model: "" }
  return {
    cli: capability.cli,
    model:
      capability.models.find((candidate) => candidate.id === currentModel)?.id ??
      (capability.cli === preferredCli
        ? capability.models.find((candidate) => candidate.id === deps.defaultModel)?.id
        : undefined) ??
      capability.models[0]?.id ?? ""
  }
}

const providerReasoning = (deps: NewWorkspaceDeps, cli: CliKind | ""): ReasoningSetting | undefined => {
  if (cli === "") return
  const provider = deps.providers?.[cli]
  if (provider === undefined || (provider.thinkingEnabled === undefined && provider.reasoningEffort === undefined)) return
  return {
    enabled: provider.thinkingEnabled ?? true,
    ...(provider.reasoningEffort === undefined ? {} : { effort: provider.reasoningEffort })
  }
}

const selectionMode = (deps: NewWorkspaceDeps, cli: CliKind | ""): PermissionMode =>
  cli === "" ? "accept-edits" : defaultModeFor(cli, deps.providers?.[cli]?.defaultMode)

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback

const isRemoteSource = (source: NewSessionSource): boolean =>
  source === "pr" || source === "github" || source.startsWith("provider:")

const resetSource = {
  source: "blank" as const,
  search: "",
  mine: false,
  pullRequests: [] as ReadonlyArray<PrSummary>,
  issues: [] as ReadonlyArray<IssueSummary>,
  selectedPr: null,
  selectedIssue: null
}

export const newWorkspaceMachine = setup({
  types: {
    context: {} as NewWorkspaceContext,
    events: {} as NewWorkspaceEvent,
    input: {} as { getDeps: () => NewWorkspaceDeps }
  },
  actors: {
    prepareWorkspace: fromPromise(async ({ input }: { input: {
      prepare: NewWorkspaceDeps["prepareProject"]
      loadBranches: NewWorkspaceDeps["loadBranches"]
      project?: Project
      environmentId?: string
      environmentKind?: Environment["kind"]
    } }) => {
      if (input.project === undefined) return { project: null, branches: [] as ReadonlyArray<string> }
      // A managed sandbox is session-scoped. Selecting Cloud must not start one
      // merely to populate this form; use the local checkout for Git metadata
      // and carry the target id into session creation, where provisioning begins.
      const deferProvisioning = input.environmentKind === "managed"
      const project = await input.prepare(
        input.project.id,
        deferProvisioning ? undefined : input.environmentId
      )
      const resolvedProject =
        deferProvisioning && input.environmentId !== undefined
          ? { ...project, environmentId: input.environmentId }
          : project
      return {
        project: resolvedProject,
        branches: await input.loadBranches(
          project.path,
          deferProvisioning ? undefined : project.environmentId
        )
      }
    }),
    loadSource: fromPromise(async ({ input }: { input: {
      deps: NewWorkspaceDeps
      project: Project | null
      source: NewSessionSource
      search: string
      mine: boolean
    } }) => {
      if (input.project === null) throw new Error("Select a project.")
      if (input.source === "pr") {
        if (!input.deps.loadPullRequests) throw new Error("GitHub pull requests are unavailable.")
        return { pullRequests: await input.deps.loadPullRequests(input.project, input.search, input.mine), issues: [] as ReadonlyArray<IssueSummary> }
      }
      if (input.source === "github") {
        if (!input.deps.loadGithubIssues) throw new Error("GitHub issues are unavailable.")
        return { pullRequests: [] as ReadonlyArray<PrSummary>, issues: await input.deps.loadGithubIssues(input.project, input.search, input.mine) }
      }
      const providerId = input.source.startsWith("provider:") ? input.source.slice("provider:".length) : ""
      if (!providerId || !input.deps.loadProviderIssues) throw new Error("This issue provider is unavailable.")
      return { pullRequests: [] as ReadonlyArray<PrSummary>, issues: await input.deps.loadProviderIssues(providerId, input.project, input.search, input.mine) }
    }),
    submit: fromCallback(({ input, sendBack }: { input: {
      run: (onProgress: (phase: SessionCreationPhase) => void) => Promise<void>
    }; sendBack: (event: NewWorkspaceEvent) => void }) => {
      let active = true
      void input.run((phase) => {
        if (active) sendBack({ type: "PROVISION_PROGRESS", phase })
      }).then(
        () => { if (active) sendBack({ type: "PROVISION_DONE" }) },
        (error) => { if (active) sendBack({ type: "PROVISION_FAILED", error }) }
      )
      return () => { active = false }
    })
  },
  guards: {
    sourceNeedsLoading: ({ event }) => event.type === "SET_SOURCE" && isRemoteSource(event.source),
    canSubmit: ({ context }) =>
      context.resolvedProject !== null &&
      context.baseBranch.length > 0 &&
      context.cli !== "" &&
      context.model !== "" &&
      (context.source === "pr" ? context.selectedPr !== null :
        context.source === "github" || context.source.startsWith("provider:") ? context.selectedIssue !== null : true)
  },
  actions: {
    seed: assign(({ context, event }) => {
      const deps = context.getDeps()
      const requested = event.type === "OPEN" ? event.projectId : undefined
      const selected = deps.projects.find((project) => project.id === requested) ??
        deps.projects.find((project) => project.id === deps.defaultProjectId) ??
        deps.projects.find((project) => project.availability === "available")
      const harness = harnessSelection(deps)
      return {
        projectId: selected?.id ?? "",
        environmentId: "local",
        resolvedProject: null,
        isolation: "worktree" as const,
        baseBranch: "",
        branches: [] as ReadonlyArray<string>,
        ...resetSource,
        draft: "",
        attachments: [] as ReadonlyArray<Attachment>,
        ...harness,
        mode: selectionMode(deps, harness.cli),
        reasoning: providerReasoning(deps, harness.cli),
        provisioningPhase: null,
        error: null
      }
    }),
    syncHarnesses: assign(({ context }) => harnessSelection(context.getDeps(), context.cli, context.model)),
    setHarness: assign(({ context, event }) => {
      if (event.type !== "SET_HARNESS") return {}
      if (event.cli === context.cli) return { cli: event.cli, model: event.model }
      const deps = context.getDeps()
      return { cli: event.cli, model: event.model, mode: selectionMode(deps, event.cli), reasoning: providerReasoning(deps, event.cli) }
    }),
    setMode: assign(({ event }) => event.type === "SET_MODE" ? { mode: event.mode } : {}),
    setReasoning: assign(({ event }) => event.type === "SET_REASONING" ? { reasoning: event.reasoning } : {}),
    setSource: assign(({ event }) => event.type === "SET_SOURCE" ? { ...resetSource, source: event.source, draft: "", error: null } : {}),
    applyBranches: assign(({ event }) => {
      const output = (event as unknown as { output: { project: Project | null; branches: ReadonlyArray<string> } }).output
      return { resolvedProject: output.project, branches: output.branches, baseBranch: preferredBranch(output.branches), error: null }
    }),
    applySource: assign(({ event }) => {
      const output = (event as unknown as { output: { pullRequests: ReadonlyArray<PrSummary>; issues: ReadonlyArray<IssueSummary> } }).output
      return { ...output, selectedPr: null, selectedIssue: null, error: null }
    }),
    setLoadError: assign(({ event }) => ({ branches: [], baseBranch: "", resolvedProject: null, error: errorText((event as unknown as { error: unknown }).error, "Could not load branches.") })),
    setSourceError: assign(({ event }) => ({ pullRequests: [], issues: [], error: errorText((event as unknown as { error: unknown }).error, "Could not load this source.") })),
    beginSubmit: assign(({ context }) => ({
      provisioningPhase: (context.environmentId === "local"
        ? "creating-session"
        : "checking-access") as SessionCreationPhase,
      error: null
    })),
    setProvisioningPhase: assign(({ event }) =>
      event.type === "PROVISION_PROGRESS" ? { provisioningPhase: event.phase } : {}
    ),
    setSubmitError: assign(({ event }) => ({
      error: errorText(event.type === "PROVISION_FAILED" ? event.error : event, "Could not create the workspace.")
    })),
    close: ({ context }) => context.getDeps().onClose()
  }
}).createMachine({
  id: "new-workspace",
  initial: "closed",
  context: ({ input }) => ({
    getDeps: input.getDeps,
    projectId: "",
    environmentId: "local",
    resolvedProject: null,
    isolation: "worktree",
    baseBranch: "",
    branches: [],
    ...resetSource,
    draft: "",
    attachments: [],
    cli: "",
    model: "",
    mode: "accept-edits",
    reasoning: undefined,
    provisioningPhase: null,
    error: null
  }),
  on: { SYNC_HARNESSES: { actions: "syncHarnesses" } },
  states: {
    closed: { on: { OPEN: { target: "loading", actions: "seed" } } },
    loading: {
      invoke: {
        src: "prepareWorkspace",
        input: ({ context }) => ({
          prepare: context.getDeps().prepareProject,
          loadBranches: context.getDeps().loadBranches,
          project: projectFor(context),
          ...(context.environmentId === "local"
            ? {}
            : {
                environmentId: context.environmentId,
                environmentKind: context.getDeps().environments?.find(
                  (environment) => environment.id === context.environmentId
                )?.kind
              })
        }),
        onDone: { target: "editing", actions: "applyBranches" },
        onError: { target: "editing", actions: "setLoadError" }
      },
      on: {
        CLOSE: { target: "closed", actions: "close" },
        SET_ENVIRONMENT: {
          target: "loading",
          reenter: true,
          actions: assign(({ event }) => ({
            environmentId: event.environmentId,
            branches: [],
            baseBranch: "",
            resolvedProject: null,
            ...resetSource,
            error: null
          }))
        },
        SET_HARNESS: { actions: "setHarness" },
        SET_MODE: { actions: "setMode" },
        SET_REASONING: { actions: "setReasoning" }
      }
    },
    editing: {
      on: {
        CLOSE: { target: "closed", actions: "close" },
        SET_PROJECT: { target: "loading", actions: assign(({ event }) => ({ projectId: event.projectId, branches: [], baseBranch: "", resolvedProject: null, ...resetSource, error: null })) },
        SET_ENVIRONMENT: { target: "loading", actions: assign(({ event }) => ({ environmentId: event.environmentId, branches: [], baseBranch: "", resolvedProject: null, ...resetSource, error: null })) },
        SET_SOURCE: [
          { guard: "sourceNeedsLoading", target: "sourceLoading", actions: "setSource" },
          { actions: "setSource" }
        ],
        SET_SEARCH: { target: "sourceLoading", actions: assign(({ event }) => ({ search: event.search })) },
        SET_MINE: { target: "sourceLoading", actions: assign(({ event }) => ({ mine: event.mine })) },
        SET_ISOLATION: { actions: assign(({ event }) => ({ isolation: event.isolation })) },
        SET_BASE: { actions: assign(({ event }) => ({ baseBranch: event.baseBranch })) },
        SELECT_PR: { actions: assign(({ event }) => ({ selectedPr: event.pr, baseBranch: event.pr.baseRefName })) },
        SELECT_ISSUE: { actions: assign(({ event }) => ({ selectedIssue: event.issue, draft: [event.issue.title, event.issue.body].filter(Boolean).join("\n\n") })) },
        SET_DRAFT: { actions: assign(({ event }) => ({ draft: event.draft })) },
        SET_ATTACHMENTS: { actions: assign(({ event }) => ({ attachments: event.attachments })) },
        SET_HARNESS: { actions: "setHarness" },
        SET_MODE: { actions: "setMode" },
        SET_REASONING: { actions: "setReasoning" },
        SUBMIT: { guard: "canSubmit", target: "submitting", actions: "beginSubmit" }
      }
    },
    sourceLoading: {
      invoke: {
        src: "loadSource",
        input: ({ context }) => ({ deps: context.getDeps(), project: context.resolvedProject, source: context.source, search: context.search, mine: context.mine }),
        onDone: { target: "editing", actions: "applySource" },
        onError: { target: "editing", actions: "setSourceError" }
      },
      on: {
        CLOSE: { target: "closed", actions: "close" },
        SET_SOURCE: [
          { guard: "sourceNeedsLoading", target: "sourceLoading", reenter: true, actions: "setSource" },
          { target: "editing", actions: "setSource" }
        ],
        SET_SEARCH: { target: "sourceLoading", reenter: true, actions: assign(({ event }) => ({ search: event.search })) },
        SET_MINE: { target: "sourceLoading", reenter: true, actions: assign(({ event }) => ({ mine: event.mine })) }
      }
    },
    submitting: {
      invoke: {
        src: "submit",
        input: ({ context }) => ({
          run: (onProgress) => {
            const project = context.resolvedProject
            if (project === null) return Promise.reject(new Error("Select a project."))
            if (context.cli === "") return Promise.reject(new Error("Select a harness."))
            const common = {
              projectId: project.id,
              ...(project.environmentId === undefined ? {} : { environmentId: project.environmentId }),
              repoPath: project.path,
              repoName: project.name,
              cli: context.cli,
              model: context.model,
              mode: context.mode,
              reasoning: context.reasoning ?? null
            }
            if (context.source === "pr") {
              const createFromPr = context.getDeps().onCreateFromPr
              if (!context.selectedPr || !createFromPr) return Promise.reject(new Error("Select a pull request."))
              return createFromPr({ ...common, ...(context.draft.trim() ? { initialPrompt: context.draft.trim() } : {}), pr: context.selectedPr }, context.attachments, onProgress)
            }
            if (context.source === "github" || context.source.startsWith("provider:")) {
              const createFromIssue = context.getDeps().onCreateFromIssue
              if (!context.selectedIssue || !createFromIssue) return Promise.reject(new Error("Select an issue."))
              return createFromIssue({ ...common, baseBranch: context.baseBranch, issue: context.selectedIssue, task: context.draft.trim() }, context.attachments, onProgress)
            }
            return context.getDeps().onCreate({
              ...common,
              ...(context.draft.trim() ? { initialPrompt: context.draft.trim() } : {}),
              baseBranch: context.baseBranch,
              useWorktree: context.isolation === "worktree",
              ...(context.source === "branch" ? { continueBranch: true } : {})
            }, context.attachments, onProgress)
          }
        })
      },
      on: {
        PROVISION_PROGRESS: { actions: "setProvisioningPhase" },
        PROVISION_DONE: { target: "closed", actions: "close" },
        PROVISION_FAILED: { target: "editing", actions: "setSubmitError" },
        CLOSE: { target: "closed", actions: "close" }
      }
    }
  }
})
