import type { Project } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export type AddProjectMethod = "existing" | "browse" | "clone" | "new"

export interface AddProjectDeps {
  browse: () => Promise<string | null>
  register: (input: { path: string; name?: string }) => Promise<Project>
  createDirectory: (input: { path: string; name?: string }) => Promise<Project>
  clone: (input: { url: string; destination: string; name?: string }) => Promise<Project>
  onAdded: (project: Project) => void
  onClose: () => void
}

export interface AddProjectContext {
  getDeps: () => AddProjectDeps
  method: AddProjectMethod | null
  path: string
  url: string
  name: string
  error: string | null
}

type AddProjectEvent =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "BACK" }
  | { type: "SELECT"; method: AddProjectMethod }
  | { type: "SET_PATH"; path: string }
  | { type: "SET_URL"; url: string }
  | { type: "SET_NAME"; name: string }
  | { type: "SUBMIT" }

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Could not add the project."

export const addProjectMachine = setup({
  types: {
    context: {} as AddProjectContext,
    events: {} as AddProjectEvent,
    input: {} as { getDeps: () => AddProjectDeps }
  },
  actors: {
    browse: fromPromise(({ input }: { input: { run: AddProjectDeps["browse"] } }) => input.run()),
    submit: fromPromise(
      ({ input }: { input: { run: () => Promise<Project> } }) => input.run()
    )
  },
  guards: {
    canSubmit: ({ context }) =>
      context.method === "clone"
        ? context.url.trim().length > 0 && context.path.trim().length > 0
        : context.path.trim().length > 0
  },
  actions: {
    reset: assign({ method: null, path: "", url: "", name: "", error: null }),
    close: ({ context }) => context.getDeps().onClose(),
    added: ({ context, event }) => {
      const project = (event as unknown as { output: Project }).output
      context.getDeps().onAdded(project)
    },
    setError: assign(({ event }) => ({
      error: errorText((event as unknown as { error: unknown }).error)
    }))
  }
}).createMachine({
  id: "add-project",
  initial: "closed",
  context: ({ input }) => ({
    getDeps: input.getDeps,
    method: null,
    path: "",
    url: "",
    name: "",
    error: null
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
            guard: ({ event }) => event.method === "browse",
            target: "browsing",
            actions: assign({ method: "browse", error: null })
          },
          {
            target: "form",
            actions: assign(({ event }) => ({ method: event.method, error: null }))
          }
        ]
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
      }
    },
    form: {
      on: {
        CLOSE: { target: "closed", actions: "close" },
        BACK: { target: "methods", actions: assign({ error: null }) },
        SET_PATH: { actions: assign(({ event }) => ({ path: event.path })) },
        SET_URL: { actions: assign(({ event }) => ({ url: event.url })) },
        SET_NAME: { actions: assign(({ event }) => ({ name: event.name })) },
        SUBMIT: { guard: "canSubmit", target: "submitting" }
      }
    },
    submitting: {
      invoke: {
        src: "submit",
        input: ({ context }) => ({
          run: () => {
            const deps = context.getDeps()
            const name = context.name.trim() || undefined
            if (context.method === "clone") {
              return deps.clone({
                url: context.url.trim(),
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
        }),
        onDone: { target: "closed", actions: ["added", "close"] },
        onError: { target: "form", actions: "setError" }
      }
    }
  }
})
