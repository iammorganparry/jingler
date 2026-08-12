import type {
  Attachment,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  Environment,
  IssueProviderDescriptor,
  IssueSummary,
  PermissionMode,
  ProviderCatalog,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
  PrSummary,
  Project,
  ReasoningSetting
} from "@jingler/core"
import type { SessionCreationPhase } from "@jingler/contracts"
import { assign, fromCallback, fromPromise, setup } from "xstate"

export type NewSessionSource = "blank" | "branch" | "pr" | "github" | `provider:${string}`

export interface NewWorkspaceDeps {
  projects: ReadonlyArray<Project>
  environments?: ReadonlyArray<Environment>
  issueProviders?: ReadonlyArray<IssueProviderDescriptor>
  providerCatalog?: ProviderCatalog | null
  defaultConnectionId?: ProviderConnectionId | null
  defaultModelId?: ProviderModelId | null
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
  mode: PermissionMode
  reasoning?: ReasoningSetting
  connectionId: ProviderConnectionId | null
  providerId: ProviderId | null
  modelId: ProviderModelId | null
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
  | {
      type: "SET_MODEL"
      connectionId: ProviderConnectionId
      providerId: ProviderId
      modelId: ProviderModelId
    }
  | { type: "SET_MODE"; mode: PermissionMode }
  | { type: "SET_REASONING"; reasoning?: ReasoningSetting }
  | { type: "SYNC_MODELS" }
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

const providerSelection = (
  deps: NewWorkspaceDeps,
  currentConnectionId: ProviderConnectionId | null = null,
  currentModelId: ProviderModelId | null = null
): {
  connectionId: ProviderConnectionId | null
  providerId: ProviderId | null
  modelId: ProviderModelId | null
} => {
  const choices = (deps.providerCatalog?.connections ?? []).flatMap(({ connection, models }) =>
    models
      .filter(({ selectable }) => selectable)
      .map((model) => ({
        connectionId: connection.id,
        providerId: model.providerId,
        modelId: model.id
      }))
  )
  const selected =
    choices.find((choice) =>
      choice.connectionId === currentConnectionId && choice.modelId === currentModelId
    ) ??
    choices.find((choice) =>
      choice.connectionId === deps.defaultConnectionId && choice.modelId === deps.defaultModelId
    ) ??
    choices[0]
  return selected ?? { connectionId: null, providerId: null, modelId: null }
}

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
      // Remote preparation belongs to submission, not target selection. Use the
      // local checkout for branch metadata and carry the environment identity
      // into session creation. The backend then reports the same explicit
      // startup phases for an owned host or a managed sandbox.
      const deferProvisioning = input.environmentId !== undefined
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
      context.connectionId !== null &&
      context.providerId !== null &&
      context.modelId !== null &&
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
      const provider = providerSelection(deps)
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
        ...provider,
        mode: "accept-edits" as const,
        reasoning: undefined,
        provisioningPhase: null,
        error: null
      }
    }),
    syncProviderModels: assign(({ context }) =>
      providerSelection(context.getDeps(), context.connectionId, context.modelId)
    ),
    setProviderModel: assign(({ event }) =>
      event.type === "SET_MODEL"
        ? {
            connectionId: event.connectionId,
            providerId: event.providerId,
            modelId: event.modelId
          }
        : {}
    ),
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
    mode: "accept-edits",
    reasoning: undefined,
    connectionId: null,
    providerId: null,
    modelId: null,
    provisioningPhase: null,
    error: null
  }),
  on: {
    SYNC_MODELS: { actions: "syncProviderModels" },
    SET_MODEL: { actions: "setProviderModel" }
  },
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
            const canonical =
              context.connectionId !== null &&
              context.providerId !== null &&
              context.modelId !== null
                ? {
                    connectionId: context.connectionId,
                    providerId: context.providerId,
                    modelId: context.modelId
                }
                : null
            if (canonical === null) {
              return Promise.reject(new Error("Select a certified provider model."))
            }
            const common = {
              projectId: project.id,
              ...(project.environmentId === undefined ? {} : { environmentId: project.environmentId }),
              repoPath: project.path,
              repoName: project.name,
              ...canonical,
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
