import type {
  CliInfo,
  CliKind,
  CreateSessionInput,
  HarnessCapability,
  PermissionMode,
  ProvidersConfig,
  Project
} from "@jingler/core"
import type { ReasoningSetting } from "@jingler/core"
import { defaultModeFor, newSessionCli } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export interface NewWorkspaceDeps {
  projects: ReadonlyArray<Project>
  clis: ReadonlyArray<CliInfo>
  capabilities: ReadonlyArray<HarnessCapability>
  defaultCli?: CliKind | null
  defaultModel?: string | null
  providers?: ProvidersConfig | null
  defaultProjectId?: string | null
  loadBranches: (path: string, environmentId?: string) => Promise<ReadonlyArray<string>>
  prepareProject: (projectId: string, environmentId?: string) => Promise<Project>
  onCreate: (input: CreateSessionInput) => Promise<void>
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
  draft: string
  cli: CliKind | ""
  model: string
  mode: PermissionMode
  reasoning?: ReasoningSetting
  error: string | null
}

type NewWorkspaceEvent =
  | { type: "OPEN"; projectId?: string }
  | { type: "CLOSE" }
  | { type: "SET_PROJECT"; projectId: string }
  | { type: "SET_ENVIRONMENT"; environmentId: string }
  | { type: "SET_ISOLATION"; isolation: "worktree" | "direct" }
  | { type: "SET_BASE"; baseBranch: string }
  | { type: "SET_DRAFT"; draft: string }
  | { type: "SET_HARNESS"; cli: CliKind; model: string }
  | { type: "SET_MODE"; mode: PermissionMode }
  | { type: "SET_REASONING"; reasoning?: ReasoningSetting }
  | { type: "SYNC_HARNESSES" }
  | { type: "SUBMIT" }

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

  const preservedModel = capability.models.find((candidate) => candidate.id === currentModel)?.id
  const configuredModel = capability.cli === preferredCli
    ? capability.models.find((candidate) => candidate.id === deps.defaultModel)?.id
    : undefined
  return {
    cli: capability.cli,
    model: preservedModel ?? configuredModel ?? capability.models[0]?.id ?? ""
  }
}

const providerReasoning = (
  deps: NewWorkspaceDeps,
  cli: CliKind | ""
): ReasoningSetting | undefined => {
  if (cli === "") return
  const provider = deps.providers?.[cli]
  if (
    provider === undefined ||
    (provider.thinkingEnabled === undefined && provider.reasoningEffort === undefined)
  ) return
  return {
    enabled: provider.thinkingEnabled ?? true,
    ...(provider.reasoningEffort === undefined ? {} : { effort: provider.reasoningEffort })
  }
}

const selectionMode = (deps: NewWorkspaceDeps, cli: CliKind | ""): PermissionMode =>
  cli === "" ? "accept-edits" : defaultModeFor(cli, deps.providers?.[cli]?.defaultMode)

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback

export const newWorkspaceMachine = setup({
  types: {
    context: {} as NewWorkspaceContext,
    events: {} as NewWorkspaceEvent,
    input: {} as { getDeps: () => NewWorkspaceDeps }
  },
  actors: {
    prepareWorkspace: fromPromise(
      async ({ input }: { input: {
        prepare: NewWorkspaceDeps["prepareProject"]
        loadBranches: NewWorkspaceDeps["loadBranches"]
        project?: Project
        environmentId?: string
      } }) => {
        if (input.project === undefined) return { project: null, branches: [] as ReadonlyArray<string> }
        const project = await input.prepare(input.project.id, input.environmentId)
        const branches = await input.loadBranches(project.path, project.environmentId)
        return { project, branches }
      }
    ),
    submit: fromPromise(({ input }: { input: { run: () => Promise<void> } }) => input.run())
  },
  guards: {
    canSubmit: ({ context }) =>
      context.resolvedProject !== null &&
      context.baseBranch.length > 0 &&
      context.cli !== "" &&
      context.model !== ""
  },
  actions: {
    seed: assign(({ context, event }) => {
      const deps = context.getDeps()
      const requested = event.type === "OPEN" ? event.projectId : undefined
      const selected =
        deps.projects.find((project) => project.id === requested) ??
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
        draft: "",
        ...harness,
        mode: selectionMode(deps, harness.cli),
        reasoning: providerReasoning(deps, harness.cli),
        error: null
      }
    }),
    syncHarnesses: assign(({ context }) =>
      harnessSelection(context.getDeps(), context.cli, context.model)),
    setHarness: assign(({ context, event }) => {
      if (event.type !== "SET_HARNESS") return {}
      if (event.cli === context.cli) return { cli: event.cli, model: event.model }
      const deps = context.getDeps()
      return {
        cli: event.cli,
        model: event.model,
        mode: selectionMode(deps, event.cli),
        reasoning: providerReasoning(deps, event.cli)
      }
    }),
    setMode: assign(({ event }) =>
      event.type === "SET_MODE" ? { mode: event.mode } : {}),
    setReasoning: assign(({ event }) =>
      event.type === "SET_REASONING" ? { reasoning: event.reasoning } : {}),
    applyBranches: assign(({ event }) => {
      const output = (event as unknown as { output: { project: Project | null; branches: ReadonlyArray<string> } }).output
      return { resolvedProject: output.project, branches: output.branches, baseBranch: preferredBranch(output.branches), error: null }
    }),
    setLoadError: assign(({ event }) => ({
      branches: [],
      baseBranch: "",
      resolvedProject: null,
      error: errorText((event as unknown as { error: unknown }).error, "Could not load branches.")
    })),
    setSubmitError: assign(({ event }) => ({
      error: errorText((event as unknown as { error: unknown }).error, "Could not create the workspace.")
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
    draft: "",
    cli: "",
    model: "",
    mode: "accept-edits",
    reasoning: undefined,
    error: null
  }),
  on: {
    SYNC_HARNESSES: { actions: "syncHarnesses" }
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
          ...(context.environmentId === "local" ? {} : { environmentId: context.environmentId })
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
        SET_PROJECT: {
          target: "loading",
          actions: assign(({ event }) => ({
            projectId: event.projectId,
            branches: [],
            baseBranch: "",
            resolvedProject: null,
            error: null
          }))
        },
        SET_ENVIRONMENT: {
          target: "loading",
          actions: assign(({ event }) => ({
            environmentId: event.environmentId,
            branches: [],
            baseBranch: "",
            resolvedProject: null,
            error: null
          }))
        },
        SET_ISOLATION: { actions: assign(({ event }) => ({ isolation: event.isolation })) },
        SET_BASE: { actions: assign(({ event }) => ({ baseBranch: event.baseBranch })) },
        SET_DRAFT: { actions: assign(({ event }) => ({ draft: event.draft })) },
        SET_HARNESS: { actions: "setHarness" },
        SET_MODE: { actions: "setMode" },
        SET_REASONING: { actions: "setReasoning" },
        SUBMIT: { guard: "canSubmit", target: "submitting" }
      }
    },
    submitting: {
      invoke: {
        src: "submit",
        input: ({ context }) => ({
          run: () => {
            const project = context.resolvedProject
            if (project === null) return Promise.reject(new Error("Select a project."))
            const cli = context.cli
            if (cli === "") return Promise.reject(new Error("Select a harness."))
            return context.getDeps().onCreate({
              projectId: project.id,
              ...(project.environmentId === undefined ? {} : { environmentId: project.environmentId }),
              repoPath: project.path,
              repoName: project.name,
              ...(context.draft.trim() ? { initialPrompt: context.draft.trim() } : {}),
              cli,
              model: context.model,
              mode: context.mode,
              reasoning: context.reasoning ?? null,
              baseBranch: context.baseBranch,
              useWorktree: context.isolation === "worktree"
            })
          }
        }),
        onDone: { target: "closed", actions: "close" },
        onError: { target: "editing", actions: "setSubmitError" }
      }
    }
  }
})
