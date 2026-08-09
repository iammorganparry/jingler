import type { CliInfo, CliKind, CreateSessionInput, Project } from "@jingler/core"
import { newSessionCli } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export interface NewWorkspaceDeps {
  projects: ReadonlyArray<Project>
  clis: ReadonlyArray<CliInfo>
  defaultCli?: CliKind | null
  defaultProjectId?: string | null
  loadBranches: (path: string, environmentId?: string) => Promise<ReadonlyArray<string>>
  onCreate: (input: CreateSessionInput) => Promise<void>
  onClose: () => void
}

export interface NewWorkspaceContext {
  getDeps: () => NewWorkspaceDeps
  projectId: string
  isolation: "worktree" | "direct"
  baseBranch: string
  branches: ReadonlyArray<string>
  title: string
  draft: string
  cli: CliKind | ""
  error: string | null
}

type NewWorkspaceEvent =
  | { type: "OPEN"; projectId?: string }
  | { type: "CLOSE" }
  | { type: "SET_PROJECT"; projectId: string }
  | { type: "SET_ISOLATION"; isolation: "worktree" | "direct" }
  | { type: "SET_BASE"; baseBranch: string }
  | { type: "SET_TITLE"; title: string }
  | { type: "SET_DRAFT"; draft: string }
  | { type: "SUBMIT" }

const projectFor = (context: NewWorkspaceContext): Project | undefined =>
  context.getDeps().projects.find((project) => project.id === context.projectId)

const preferredBranch = (branches: ReadonlyArray<string>): string =>
  branches.find((branch) => branch === "main") ??
  branches.find((branch) => branch === "master") ??
  branches[0] ?? ""

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback

export const newWorkspaceMachine = setup({
  types: {
    context: {} as NewWorkspaceContext,
    events: {} as NewWorkspaceEvent,
    input: {} as { getDeps: () => NewWorkspaceDeps }
  },
  actors: {
    loadBranches: fromPromise(
      ({ input }: { input: { run: NewWorkspaceDeps["loadBranches"]; project?: Project } }) =>
        input.project === undefined
          ? Promise.resolve([])
          : input.run(input.project.path, input.project.environmentId)
    ),
    submit: fromPromise(({ input }: { input: { run: () => Promise<void> } }) => input.run())
  },
  guards: {
    canSubmit: ({ context }) =>
      context.projectId.length > 0 && context.baseBranch.length > 0 && context.cli !== ""
  },
  actions: {
    seed: assign(({ context, event }) => {
      const deps = context.getDeps()
      const requested = event.type === "OPEN" ? event.projectId : undefined
      const selected =
        deps.projects.find((project) => project.id === requested) ??
        deps.projects.find((project) => project.id === deps.defaultProjectId) ??
        deps.projects.find((project) => project.availability === "available")
      return {
        projectId: selected?.id ?? "",
        isolation: "worktree" as const,
        baseBranch: "",
        branches: [] as ReadonlyArray<string>,
        title: "",
        draft: "",
        cli: newSessionCli(deps.clis, deps.defaultCli) ?? ("" as CliKind | ""),
        error: null
      }
    }),
    applyBranches: assign(({ event }) => {
      const branches = (event as unknown as { output: ReadonlyArray<string> }).output
      return { branches, baseBranch: preferredBranch(branches), error: null }
    }),
    setLoadError: assign(({ event }) => ({
      branches: [],
      baseBranch: "",
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
    isolation: "worktree",
    baseBranch: "",
    branches: [],
    title: "",
    draft: "",
    cli: "",
    error: null
  }),
  states: {
    closed: { on: { OPEN: { target: "loading", actions: "seed" } } },
    loading: {
      invoke: {
        src: "loadBranches",
        input: ({ context }) => ({ run: context.getDeps().loadBranches, project: projectFor(context) }),
        onDone: { target: "editing", actions: "applyBranches" },
        onError: { target: "editing", actions: "setLoadError" }
      },
      on: { CLOSE: { target: "closed", actions: "close" } }
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
            error: null
          }))
        },
        SET_ISOLATION: { actions: assign(({ event }) => ({ isolation: event.isolation })) },
        SET_BASE: { actions: assign(({ event }) => ({ baseBranch: event.baseBranch })) },
        SET_TITLE: { actions: assign(({ event }) => ({ title: event.title })) },
        SET_DRAFT: { actions: assign(({ event }) => ({ draft: event.draft })) },
        SUBMIT: { guard: "canSubmit", target: "submitting" }
      }
    },
    submitting: {
      invoke: {
        src: "submit",
        input: ({ context }) => ({
          run: () => {
            const project = projectFor(context)
            if (project === undefined) return Promise.reject(new Error("Select a project."))
            return context.getDeps().onCreate({
              projectId: project.id,
              ...(project.environmentId === undefined ? {} : { environmentId: project.environmentId }),
              repoPath: project.path,
              repoName: project.name,
              ...(context.title.trim() ? { title: context.title.trim() } : {}),
              ...(context.draft.trim() ? { initialPrompt: context.draft.trim() } : {}),
              cli: context.cli as CliKind,
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
