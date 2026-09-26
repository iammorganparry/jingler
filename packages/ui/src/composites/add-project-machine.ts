import type { GitHubCloneRepository, Project, ProjectDirectoryListing } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export type AddProjectMethod = "existing" | "clone" | "new"

export interface AddProjectDeps {
  browse: () => Promise<string | null>
  browseCloneDestination: (repositoryName: string) => Promise<string | null>
  listDirectories: (path?: string) => Promise<ProjectDirectoryListing>
  listGitHubRepositories: () => Promise<ReadonlyArray<GitHubCloneRepository>>
  register: (input: { path: string; name?: string }) => Promise<Project>
  createDirectory: (input: { path: string; name?: string }) => Promise<Project>
  clone: (input: { url: string; destination: string; name?: string }) => Promise<Project>
  cloneFromGitHub: (input: {
    installationId?: string
    repository: string
    destination: string
    name?: string
  }) => Promise<Project>
  onAdded: (project: Project) => void
  onClose: () => void
}

export interface AddProjectContext {
  getDeps: () => AddProjectDeps
  method: AddProjectMethod | null
  path: string
  name: string
  error: string | null
  directoryPath: string | undefined
  directoryListing: ProjectDirectoryListing | null
  directoryError: string | null
  githubRepositories: ReadonlyArray<GitHubCloneRepository>
  selectedGitHubRepository: GitHubCloneRepository | null
  remoteUrl: string
  githubError: string | null
}

type AddProjectEvent =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "BACK" }
  | { type: "SELECT"; method: AddProjectMethod }
  | { type: "SET_PATH"; path: string }
  | { type: "SET_NAME"; name: string }
  | { type: "OPEN_DIRECTORY"; path?: string }
  | { type: "BROWSE" }
  | { type: "CHOOSE_DIRECTORY"; path: string }
  | { type: "SELECT_GITHUB_REPOSITORY"; repository: GitHubCloneRepository }
  | { type: "SET_REMOTE_URL"; url: string }
  | { type: "SELECT_REMOTE_URL" }
  | { type: "SUBMIT" }

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Could not add the project."

export const repositoryNameFromUrl = (value: string): string =>
  value.trim().replace(/[\\/]+$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/i, "") || "repository"

const submitProject = (context: AddProjectContext): Promise<Project> => {
  const deps = context.getDeps()
  const name = context.name.trim() || undefined
  if (context.method === "clone" && context.selectedGitHubRepository) {
    return deps.cloneFromGitHub({
      installationId: context.selectedGitHubRepository.installationId,
      repository: context.selectedGitHubRepository.fullName,
      destination: context.path.trim(),
      ...(name === undefined ? {} : { name })
    })
  }
  if (context.method === "clone") {
    return deps.clone({
      url: context.remoteUrl.trim(),
      destination: context.path.trim(),
      ...(name === undefined ? {} : { name })
    })
  }
  if (context.method === "new") {
    return deps.createDirectory({
      path: context.path.trim(),
      ...(name === undefined ? {} : { name })
    })
  }
  return deps.register({
    path: context.path.trim(),
    ...(name === undefined ? {} : { name })
  })
}

export const addProjectMachine = setup({
  types: {
    context: {} as AddProjectContext,
    events: {} as AddProjectEvent,
    input: {} as { getDeps: () => AddProjectDeps }
  },
  actors: {
    browse: fromPromise(({ input }: { input: { run: AddProjectDeps["browse"] } }) => input.run()),
    browseCloneDestination: fromPromise(
      ({ input }: { input: { run: AddProjectDeps["browseCloneDestination"]; repositoryName: string } }) =>
        input.run(input.repositoryName)
    ),
    listDirectories: fromPromise(
      ({ input }: { input: { run: AddProjectDeps["listDirectories"]; path?: string } }) =>
        input.run(input.path)
    ),
    listGitHubRepositories: fromPromise(
      ({ input }: { input: { run: AddProjectDeps["listGitHubRepositories"] } }) => input.run()
    ),
    submit: fromPromise(
      ({ input }: { input: { run: () => Promise<Project> } }) => input.run()
    )
  },
  guards: {
    canSubmit: ({ context }) =>
      context.method === "clone"
        ? (context.selectedGitHubRepository !== null || context.remoteUrl.trim().length > 0) &&
          context.path.trim().length > 0
        : context.path.trim().length > 0,
    isClone: ({ context }) => context.method === "clone"
  },
  actions: {
    reset: assign({
      method: null,
      path: "",
      name: "",
      error: null,
      directoryPath: undefined,
      directoryListing: null,
      directoryError: null,
      githubRepositories: [],
      selectedGitHubRepository: null,
      remoteUrl: "",
      githubError: null
    }),
    close: ({ context }) => context.getDeps().onClose(),
    added: ({ context, event }) => {
      const project = (event as unknown as { output: Project }).output
      context.getDeps().onAdded(project)
    },
    setError: assign(({ event }) => ({
      error: errorText((event as unknown as { error: unknown }).error)
    })),
    setDirectoryError: assign(({ event }) => ({
      directoryError: errorText((event as unknown as { error: unknown }).error)
    })),
    setGitHubError: assign(({ event }) => ({
      githubError: errorText((event as unknown as { error: unknown }).error)
    }))
  }
}).createMachine({
  id: "add-project",
  initial: "closed",
  context: ({ input }) => ({
    getDeps: input.getDeps,
    method: null,
    path: "",
    name: "",
    error: null,
    directoryPath: undefined,
    directoryListing: null,
    directoryError: null,
    githubRepositories: [],
    selectedGitHubRepository: null,
    remoteUrl: "",
    githubError: null
  }),
  states: {
    closed: {
      on: { OPEN: { target: "methods", actions: "reset" } }
    },
    methods: {
      on: {
        CLOSE: { target: "closed", actions: "close" },
        SELECT: [
          {
            guard: ({ event }) => event.method === "existing",
            target: "directoryLoading",
            actions: assign({
              method: "existing",
              directoryPath: undefined,
              directoryListing: null,
              directoryError: null
            })
          },
          {
            guard: ({ event }) => event.method === "clone",
            target: "githubRepositoriesLoading",
            actions: assign({
              method: "clone",
              githubRepositories: [],
              selectedGitHubRepository: null,
              remoteUrl: "",
              githubError: null,
              error: null
            })
          },
          {
            target: "form",
            actions: assign(({ event }) => ({ method: event.method, error: null }))
          }
        ]
      }
    },
    directoryLoading: {
      invoke: {
        src: "listDirectories",
        input: ({ context }) => ({
          run: context.getDeps().listDirectories,
          ...(context.directoryPath === undefined ? {} : { path: context.directoryPath })
        }),
        onDone: {
          target: "directory",
          actions: assign(({ event }) => ({
            directoryListing: event.output,
            directoryPath: event.output.path,
            directoryError: null
          }))
        },
        onError: { target: "directory", actions: "setDirectoryError" }
      },
      on: {
        CLOSE: { target: "closed", actions: "close" },
        BACK: { target: "methods" }
      }
    },
    directory: {
      on: {
        CLOSE: { target: "closed", actions: "close" },
        BACK: { target: "methods", actions: assign({ directoryError: null }) },
        BROWSE: { target: "browsing", actions: assign({ error: null }) },
        OPEN_DIRECTORY: {
          target: "directoryLoading",
          actions: assign(({ event }) => ({
            directoryPath: event.path,
            directoryError: null
          }))
        },
        CHOOSE_DIRECTORY: {
          target: "form",
          actions: assign(({ event }) => ({ path: event.path, directoryError: null }))
        }
      }
    },
    browsing: {
      invoke: {
        src: "browse",
        input: ({ context }) => ({ run: context.getDeps().browse }),
        onDone: [
          {
            guard: ({ event }) => event.output !== null,
            target: "form",
            actions: assign(({ event }) => ({ path: event.output ?? "" }))
          },
          { target: "methods" }
        ],
        onError: { target: "methods", actions: "setError" }
      },
      on: { CLOSE: { target: "closed", actions: "close" } }
    },
    githubRepositoriesLoading: {
      invoke: {
        src: "listGitHubRepositories",
        input: ({ context }) => ({ run: context.getDeps().listGitHubRepositories }),
        onDone: {
          target: "githubRepositories",
          actions: assign(({ event }) => ({
            githubRepositories: event.output,
            githubError: null
          }))
        },
        onError: { target: "githubRepositories", actions: "setGitHubError" }
      },
      on: {
        CLOSE: { target: "closed", actions: "close" },
        BACK: { target: "methods" },
        SET_REMOTE_URL: {
          actions: assign(({ event }) => ({ remoteUrl: event.url, selectedGitHubRepository: null }))
        },
        SELECT_REMOTE_URL: {
          guard: ({ context }) => context.remoteUrl.trim().length > 0,
          target: "cloneDestinationBrowsing",
          actions: assign({ githubError: null, error: null })
        }
      }
    },
    githubRepositories: {
      on: {
        CLOSE: { target: "closed", actions: "close" },
        BACK: { target: "methods", actions: assign({ githubError: null }) },
        SET_REMOTE_URL: {
          actions: assign(({ event }) => ({ remoteUrl: event.url, selectedGitHubRepository: null }))
        },
        SELECT_REMOTE_URL: {
          guard: ({ context }) => context.remoteUrl.trim().length > 0,
          target: "cloneDestinationBrowsing",
          actions: assign({ githubError: null, error: null })
        },
        SELECT_GITHUB_REPOSITORY: {
          target: "cloneDestinationBrowsing",
          actions: assign(({ event }) => ({
            selectedGitHubRepository: event.repository,
            remoteUrl: "",
            githubError: null,
            error: null
          }))
        }
      }
    },
    cloneDestinationBrowsing: {
      invoke: {
        src: "browseCloneDestination",
        input: ({ context }) => ({
          run: context.getDeps().browseCloneDestination,
          repositoryName: context.selectedGitHubRepository?.fullName.split("/").at(-1) ??
            repositoryNameFromUrl(context.remoteUrl)
        }),
        onDone: [
          {
            guard: ({ event }) => event.output !== null,
            target: "cloneReady",
            actions: assign(({ event }) => ({ path: event.output ?? "", error: null }))
          },
          { target: "githubRepositories" }
        ],
        onError: { target: "githubRepositories", actions: "setGitHubError" }
      },
      on: { CLOSE: { target: "closed", actions: "close" } }
    },
    cloneReady: {
      on: {
        CLOSE: { target: "closed", actions: "close" },
        BACK: { target: "githubRepositories", actions: assign({ error: null }) },
        SET_NAME: { actions: assign(({ event }) => ({ name: event.name })) },
        SUBMIT: { guard: "canSubmit", target: "submitting" }
      }
    },
    form: {
      on: {
        CLOSE: { target: "closed", actions: "close" },
        BACK: { target: "methods", actions: assign({ error: null }) },
        SET_PATH: { actions: assign(({ event }) => ({ path: event.path })) },
        SET_NAME: { actions: assign(({ event }) => ({ name: event.name })) },
        SUBMIT: { guard: "canSubmit", target: "submitting" }
      }
    },
    submitting: {
      invoke: {
        src: "submit",
        input: ({ context }) => ({
          run: () => submitProject(context)
        }),
        onDone: { target: "closed", actions: ["added", "close"] },
        onError: [
          { guard: "isClone", target: "cloneReady", actions: "setError" },
          { target: "form", actions: "setError" }
        ]
      }
    }
  }
})
