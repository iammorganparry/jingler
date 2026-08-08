import type {
  CliInfo,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  Environment,
  EnvironmentDiscovery,
  IssueSummary,
  PrSummary,
  Repo
} from "@jingler/core"
import { newSessionCli } from "@jingler/core"
import { assign, fromPromise, raise, setup } from "xstate"

/** Which flavour of session the dialog is composing. */
export type NewSessionMode = "blank" | "pr" | "issue"

/** Which automations to enable on an issue-linked session (design I2 toggles). */
export interface IssueAutomationsForm {
  progressComments: boolean
  closeOnMerge: boolean
}

/** How long typing in the PR / issue search box settles before a fetch fires. */
const SEARCH_DEBOUNCE_MS = 250

/** Compose the prefilled task from an issue (title + body). */
const composeTask = (issue: IssueSummary | null): string =>
  issue ? [issue.title, issue.body].map((s) => s.trim()).filter((s) => s.length > 0).join("\n\n") : ""

/**
 * The live dependencies the machine reaches through — repos/clis to seed
 * defaults, the async loaders, and the create callbacks. Held behind a getter
 * (`NewSessionInput.getDeps`) so the machine always sees the component's latest
 * props without being torn down and rebuilt on every render.
 */
export interface NewSessionDeps {
  repos: ReadonlyArray<Repo>
  environments?: ReadonlyArray<Environment>
  loadEnvironmentDiscovery?: (environmentId: string) => Promise<EnvironmentDiscovery>
  /** Preselect this repo (by path) on open; falls back to the first repo. */
  defaultRepoPath?: string | null
  /** Discovered CLIs; `newSessionCli` picks from the startable ones. */
  availableClis: ReadonlyArray<CliInfo>
  /**
   * The harness configured in Settings · Providers. The dialog no longer asks —
   * it resolves this once on open and reports it read-only.
   */
  defaultCli?: CliKind | null
  loadBranches: (repoPath: string, environmentId?: string) => Promise<ReadonlyArray<string>>
  loadPrs?: (
    repoPath: string,
    opts: { mine: boolean; search: string; githubSlug?: string }
  ) => Promise<ReadonlyArray<PrSummary>>
  loadIssues?: (
    repoPath: string,
    opts: { mine: boolean; search: string; githubSlug?: string }
  ) => Promise<ReadonlyArray<IssueSummary>>
  onCreate: (input: CreateSessionInput) => Promise<void>
  onCreateFromPr?: (input: CreateSessionFromPrInput) => Promise<void>
  onCreateFromIssue?: (input: CreateSessionFromIssueInput) => Promise<void>
  onClose: () => void
}

export interface NewSessionInput {
  getDeps: () => NewSessionDeps
}

export interface NewSessionContext {
  getDeps: () => NewSessionDeps
  mode: NewSessionMode
  environmentId: string | null
  repos: ReadonlyArray<Repo>
  repoPath: string
  title: string
  cli: CliKind | ""
  base: string
  /** Blank sessions default to an isolated linked worktree on every open. */
  useWorktree: boolean
  branches: ReadonlyArray<string>
  search: string
  mine: boolean
  prs: ReadonlyArray<PrSummary>
  selectedPr: PrSummary | null
  issues: ReadonlyArray<IssueSummary>
  selectedIssue: IssueSummary | null
  /** Issue-mode two-step: pick an issue (`list`) then prefill + confirm (`detail`). */
  issueStep: "list" | "detail"
  /** Editable task (prefilled from the selected issue on advance). */
  task: string
  automations: IssueAutomationsForm
  error: string | null
}

export type NewSessionEvent =
  | { type: "OPEN" }
  | { type: "SET_MODE"; mode: NewSessionMode }
  | { type: "SET_ENVIRONMENT"; environmentId: string | null }
  | { type: "SET_REPO"; repoPath: string }
  | { type: "SET_TITLE"; title: string }
  | { type: "SET_BASE"; base: string }
  | { type: "SET_USE_WORKTREE"; useWorktree: boolean }
  | { type: "SET_SEARCH"; search: string }
  | { type: "SET_MINE"; mine: boolean }
  | { type: "SELECT_PR"; pr: PrSummary }
  | { type: "SELECT_ISSUE"; issue: IssueSummary }
  | { type: "ADVANCE" }
  | { type: "BACK" }
  | { type: "SET_TASK"; task: string }
  | { type: "SET_AUTOMATION"; key: keyof IssueAutomationsForm; value: boolean }
  | { type: "SUBMIT" }
  | { type: "LOAD_BRANCHES" }
  | { type: "RELOAD_PRS" }
  | { type: "RELOAD_ISSUES" }

const repoFor = (ctx: NewSessionContext): Repo | undefined =>
  ctx.repos.find((r) => r.path === ctx.repoPath)

/**
 * Preferred default base branch for a repo (default → current → first → none).
 * Prefers the default branch (main) so new sessions start from up-to-date main
 * rather than whatever branch happens to be checked out; the user can override.
 */
const defaultBase = (repo: Repo | undefined, branches: ReadonlyArray<string>): string =>
  repo?.defaultBranch ?? repo?.currentBranch ?? branches[0] ?? ""

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback

const DEFAULT_AUTOMATIONS: IssueAutomationsForm = { progressComments: true, closeOnMerge: true }

/**
 * The New Session dialog's form state, modelled as a machine. Concurrent
 * regions: `submission` (edit → submit → done), `branchLoad`, `prLoad`, and
 * `issueLoad` (both debounce via an `after` delay). Field edits assign into
 * context and `raise` the relevant reload; guards keep PR/issue loading inert
 * outside their modes. "From issue" adds a two-step (`issueStep`): pick an issue,
 * then prefill the task + automations before creating. The component stays a
 * thin projection of `context` + `state.matches`.
 */
export const newSessionMachine = setup({
  types: {
    context: {} as NewSessionContext,
    events: {} as NewSessionEvent,
    input: {} as NewSessionInput
  },
  delays: { search: SEARCH_DEBOUNCE_MS },
  guards: {
    inPrMode: ({ context }) => context.mode === "pr",
    inIssueMode: ({ context }) => context.mode === "issue",
    // The issue picker → detail step is reachable once an issue is chosen.
    canAdvance: ({ context }) =>
      context.mode === "issue" && context.issueStep === "list" && context.selectedIssue !== null,
    canSubmit: ({ context }) => {
      if (context.repoPath === "" || context.cli === "") return false
      if (context.mode === "pr") return context.selectedPr !== null
      if (context.mode === "issue")
        return context.issueStep === "detail" && context.selectedIssue !== null && context.base !== ""
      // Blank mode no longer requires a title — the agent auto-names the session.
      return context.base !== ""
    }
  },
  actors: {
    loadBranches: fromPromise(
      ({ input }: { input: { fn: NewSessionDeps["loadBranches"]; repoPath: string; environmentId: string | null } }) =>
        input.repoPath ? input.fn(input.repoPath, input.environmentId ?? undefined) : Promise.resolve([])
    ),
    loadPrs: fromPromise(
      ({
        input
      }: {
        input: { fn: NewSessionDeps["loadPrs"]; repoPath: string; githubSlug?: string; mine: boolean; search: string }
      }) =>
        input.fn && input.repoPath
          ? input.fn(input.repoPath, { mine: input.mine, search: input.search, ...(input.githubSlug ? { githubSlug: input.githubSlug } : {}) })
          : Promise.resolve([])
    ),
    loadIssues: fromPromise(
      ({
        input
      }: {
        input: { fn: NewSessionDeps["loadIssues"]; repoPath: string; githubSlug?: string; mine: boolean; search: string }
      }) =>
        input.fn && input.repoPath
          ? input.fn(input.repoPath, { mine: input.mine, search: input.search, ...(input.githubSlug ? { githubSlug: input.githubSlug } : {}) })
          : Promise.resolve([])
    ),
    loadEnvironment: fromPromise(async ({ input }: { input: { environmentId: string | null; deps: NewSessionDeps } }) => {
      if (input.environmentId === null) return input.deps.repos
      if (!input.deps.loadEnvironmentDiscovery) return []
      const result = await input.deps.loadEnvironmentDiscovery(input.environmentId)
      return (result.discovery?.repositories ?? []).map((repo) => ({
        name: repo.name,
        path: repo.path,
        defaultBranch: repo.defaultBranch,
        currentBranch: repo.currentBranch,
        remoteUrl: null,
        githubSlug: repo.githubSlug
      }))
    }),
    submit: fromPromise(({ input }: { input: { run: () => Promise<void> } }) => input.run())
  },
  actions: {
    /** Reset the form to first-open defaults, seeded from live deps. */
    seed: assign(({ context }) => {
      const deps = context.getDeps()
      // Preselect the previously-used repo when it's still present, else the first.
      const preferred = deps.defaultRepoPath
        ? deps.repos.find((r) => r.path === deps.defaultRepoPath)
        : undefined
      const first = preferred ?? deps.repos[0]
      return {
        mode: "blank" as NewSessionMode,
        environmentId: null,
        repos: deps.repos,
        repoPath: first?.path ?? "",
        title: "",
        // Not a form field any more: the harness comes from Settings, falling
        // back to whatever IS installed so an unset (or stale) default still
        // creates sessions.
        cli: newSessionCli(deps.availableClis, deps.defaultCli) ?? ("" as CliKind | ""),
        base: "",
        useWorktree: true,
        branches: [] as ReadonlyArray<string>,
        search: "",
        mine: false,
        prs: [] as ReadonlyArray<PrSummary>,
        selectedPr: null,
        issues: [] as ReadonlyArray<IssueSummary>,
        selectedIssue: null,
        issueStep: "list" as const,
        task: "",
        automations: DEFAULT_AUTOMATIONS,
        error: null
      }
    }),
    applyBranches: assign(({ context, event }) => {
      const branches = (event as unknown as { output: ReadonlyArray<string> }).output
      return { branches, base: defaultBase(repoFor(context), branches) }
    }),
    clearBranches: assign({ branches: [], base: "" }),
    applyPrs: assign({
      prs: ({ event }) => (event as unknown as { output: ReadonlyArray<PrSummary> }).output
    }),
    clearPrs: assign({ prs: [] }),
    applyIssues: assign({
      issues: ({ event }) => (event as unknown as { output: ReadonlyArray<IssueSummary> }).output
    }),
    clearIssues: assign({ issues: [] }),
    setError: assign({
      error: ({ event }) =>
        errorText((event as unknown as { error: unknown }).error, "Failed to create session.")
    })
  }
}).createMachine({
  id: "newSession",
  context: ({ input }) => ({
    getDeps: input.getDeps,
    mode: "blank",
    environmentId: null,
    repos: [],
    repoPath: "",
    title: "",
    cli: "",
    base: "",
    useWorktree: true,
    branches: [],
    search: "",
    mine: false,
    prs: [],
    selectedPr: null,
    issues: [],
    selectedIssue: null,
    issueStep: "list",
    task: "",
    automations: DEFAULT_AUTOMATIONS,
    error: null
  }),
  type: "parallel",
  states: {
    submission: {
      initial: "editing",
      states: {
        editing: {
          on: { SUBMIT: { target: "submitting", guard: "canSubmit", actions: assign({ error: null }) } }
        },
        submitting: {
          invoke: {
            src: "submit",
            input: ({ context }) => ({
              run: () => {
                const deps = context.getDeps()
                const repo = repoFor(context)
                if (!repo) return Promise.reject(new Error("No repository selected."))
                if (context.cli === "") return Promise.reject(new Error("Select a harness."))
                if (context.mode === "pr") {
                  if (!context.selectedPr || !deps.onCreateFromPr) {
                    return Promise.reject(new Error("Select a pull request."))
                  }
                return deps.onCreateFromPr({
                    ...(context.environmentId === null ? {} : { environmentId: context.environmentId }),
                    repoPath: repo.path,
                    repoName: repo.name,
                    cli: context.cli,
                    pr: {
                      number: context.selectedPr.number,
                      title: context.selectedPr.title,
                      headRefName: context.selectedPr.headRefName,
                      baseRefName: context.selectedPr.baseRefName
                    }
                  })
                }
                if (context.mode === "issue") {
                  const issue = context.selectedIssue
                  if (!issue || !deps.onCreateFromIssue) {
                    return Promise.reject(new Error("Select an issue."))
                  }
                  return deps.onCreateFromIssue({
                    ...(context.environmentId === null ? {} : { environmentId: context.environmentId }),
                    repoPath: repo.path,
                    repoName: repo.name,
                    cli: context.cli,
                    baseBranch: context.base,
                    issue: {
                      number: issue.number,
                      title: issue.title,
                      url: issue.url,
                      body: issue.body,
                      labels: issue.labels
                    },
                    task: context.task,
                    automations: context.automations
                  })
                }
                const title = context.title.trim()
                return deps.onCreate({
                  ...(context.environmentId === null ? {} : { environmentId: context.environmentId }),
                  repoPath: repo.path,
                  repoName: repo.name,
                  // Omit when blank → the session is auto-named (title is optional).
                  ...(title ? { title } : {}),
                  cli: context.cli,
                  baseBranch: context.base,
                  useWorktree: context.useWorktree
                })
              }
            }),
            onDone: { target: "done" },
            onError: { target: "editing", actions: "setError" }
          }
        },
        done: { entry: ({ context }) => context.getDeps().onClose() }
      }
    },
    branchLoad: {
      initial: "idle",
      on: { LOAD_BRANCHES: ".loading" },
      states: {
        idle: {},
        loading: {
          invoke: {
            src: "loadBranches",
            input: ({ context }) => ({ fn: context.getDeps().loadBranches, repoPath: context.repoPath, environmentId: context.environmentId }),
            onDone: { target: "idle", actions: "applyBranches" },
            onError: { target: "idle", actions: "clearBranches" }
          }
        }
      }
    },
    prLoad: {
      initial: "idle",
      on: { RELOAD_PRS: { target: ".debouncing", guard: "inPrMode" } },
      states: {
        idle: {},
        // Debounce typing: a fresh RELOAD_PRS re-enters and restarts the timer.
        debouncing: { after: { search: "loading" } },
        loading: {
          invoke: {
            src: "loadPrs",
            input: ({ context }) => ({
              fn: context.getDeps().loadPrs,
              repoPath: context.repoPath,
              githubSlug: context.repos.find((repo) => repo.path === context.repoPath)?.githubSlug ?? undefined,
              mine: context.mine,
              search: context.search
            }),
            onDone: { target: "idle", actions: "applyPrs" },
            onError: { target: "idle", actions: "clearPrs" }
          }
        }
      }
    },
    issueLoad: {
      initial: "idle",
      on: { RELOAD_ISSUES: { target: ".debouncing", guard: "inIssueMode" } },
      states: {
        idle: {},
        debouncing: { after: { search: "loading" } },
        loading: {
          invoke: {
            src: "loadIssues",
            input: ({ context }) => ({
              fn: context.getDeps().loadIssues,
              repoPath: context.repoPath,
              githubSlug: context.repos.find((repo) => repo.path === context.repoPath)?.githubSlug ?? undefined,
              mine: context.mine,
              search: context.search
            }),
            onDone: { target: "idle", actions: "applyIssues" },
            onError: { target: "idle", actions: "clearIssues" }
          }
        }
      }
    },
    environmentLoad: {
      initial: "idle",
      states: {
        idle: {
          on: {
            SET_ENVIRONMENT: {
              target: "loading",
              actions: assign({ environmentId: ({ event }) => event.environmentId })
            }
          }
        },
        loading: {
          invoke: {
            src: "loadEnvironment",
            input: ({ context }) => ({ environmentId: context.environmentId, deps: context.getDeps() }),
            onDone: {
              target: "idle",
              actions: [assign({
                repos: ({ event }) => event.output,
                repoPath: ({ event }) => event.output[0]?.path ?? "",
                branches: [],
                base: ""
              }), raise({ type: "LOAD_BRANCHES" })]
            },
            onError: { target: "idle", actions: assign({ repos: [], repoPath: "", branches: [], base: "" }) }
          }
        }
      }
    }
  },
  on: {
    OPEN: {
      target: ".submission.editing",
      actions: ["seed", raise({ type: "LOAD_BRANCHES" })]
    },
    SET_MODE: {
      actions: [
        // Reset the shared picker filters so switching PR ↔ issue gives a clean
        // slate — `search`/`mine` are shared context and would otherwise carry a
        // PR-mode query (e.g. "auth") straight into the issue picker.
        assign({
          mode: ({ event }) => event.mode,
          issueStep: "list",
          error: null,
          search: "",
          mine: false
        }),
        raise({ type: "RELOAD_PRS" }),
        raise({ type: "RELOAD_ISSUES" })
      ]
    },
    SET_ENVIRONMENT: {
      actions: assign({ environmentId: ({ event }) => event.environmentId }),
      target: ".environmentLoad.loading"
    },
    SET_REPO: {
      actions: [
        assign({
          repoPath: ({ event }) => event.repoPath,
          base: "",
          selectedPr: null,
          selectedIssue: null,
          issueStep: "list"
        }),
        raise({ type: "LOAD_BRANCHES" }),
        raise({ type: "RELOAD_PRS" }),
        raise({ type: "RELOAD_ISSUES" })
      ]
    },
    SET_TITLE: { actions: assign({ title: ({ event }) => event.title }) },
    SET_BASE: { actions: assign({ base: ({ event }) => event.base }) },
    SET_USE_WORKTREE: {
      actions: assign({ useWorktree: ({ event }) => event.useWorktree })
    },
    SET_SEARCH: {
      actions: [
        assign({ search: ({ event }) => event.search }),
        raise({ type: "RELOAD_PRS" }),
        raise({ type: "RELOAD_ISSUES" })
      ]
    },
    SET_MINE: {
      actions: [
        assign({ mine: ({ event }) => event.mine }),
        raise({ type: "RELOAD_PRS" }),
        raise({ type: "RELOAD_ISSUES" })
      ]
    },
    SELECT_PR: { actions: assign({ selectedPr: ({ event }) => event.pr }) },
    SELECT_ISSUE: { actions: assign({ selectedIssue: ({ event }) => event.issue }) },
    // Advance to the prefill/automations step and seed the editable task.
    ADVANCE: {
      guard: "canAdvance",
      actions: assign({ issueStep: "detail", task: ({ context }) => composeTask(context.selectedIssue) })
    },
    BACK: { actions: assign({ issueStep: "list" }) },
    SET_TASK: { actions: assign({ task: ({ event }) => event.task }) },
    SET_AUTOMATION: {
      actions: assign({
        automations: ({ context, event }) => ({ ...context.automations, [event.key]: event.value })
      })
    }
  }
})
