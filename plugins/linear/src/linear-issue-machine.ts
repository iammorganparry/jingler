import type { IssueReference, IssueSummary } from "@jingler/plugin-sdk"
import { assign, fromPromise, setup } from "xstate"
import type { LinearContext, LinearIssueDetail } from "./types.js"

export type { LinearIssueDetail } from "./types.js"
export type LinearWorkspaceContext = LinearContext

export interface CreateLinearIssueInput {
  readonly teamId: string
  readonly title: string
  readonly description?: string
}

export interface LinearIssueServices {
  configured(): Promise<boolean>
  context(): Promise<LinearWorkspaceContext>
  list(query: string): Promise<readonly IssueSummary[]>
  get(issueId: string): Promise<LinearIssueDetail>
  create(input: CreateLinearIssueInput): Promise<IssueSummary>
  comment(issueId: string, body: string): Promise<void>
  link(issue: IssueReference): Promise<void>
  unlink(): Promise<void>
}

export interface LinearIssueMachineInput {
  readonly linkedIssue?: IssueReference
  readonly services: LinearIssueServices
}

interface LinearIssueContext {
  services: LinearIssueServices
  linkedIssue?: IssueReference
  issue: LinearIssueDetail | null
  workspace: LinearWorkspaceContext | null
  results: readonly IssueSummary[]
  query: string
  createInput: CreateLinearIssueInput
  commentBody: string
  error: string | null
}

type LinearIssueEvent =
  | { type: "CONFIGURATION_CHANGED" }
  | { type: "SEARCH_CHANGED"; query: string }
  | { type: "SEARCH" }
  | { type: "LINK"; issue: IssueSummary }
  | { type: "CREATE_CHANGED"; field: keyof CreateLinearIssueInput; value: string }
  | { type: "CREATE_SUBMIT" }
  | { type: "REFRESH" }
  | { type: "COMMENT_CHANGED"; body: string }
  | { type: "COMMENT_SUBMIT" }
  | { type: "UNLINK" }
  | { type: "RETRY" }

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const referenceOf = (issue: IssueReference): IssueReference => ({
  providerId: issue.providerId,
  id: issue.id,
  identifier: issue.identifier,
  url: issue.url,
  title: issue.title,
  labels: issue.labels
})

export const linearIssueMachine = setup({
  types: {
    context: {} as LinearIssueContext,
    events: {} as LinearIssueEvent,
    input: {} as LinearIssueMachineInput
  },
  actors: {
    checkConfiguration: fromPromise(
      ({ input }: { input: { services: LinearIssueServices } }) => input.services.configured()
    ),
    loadContext: fromPromise(
      ({ input }: { input: { services: LinearIssueServices } }) => input.services.context()
    ),
    searchIssues: fromPromise(
      ({ input }: { input: { services: LinearIssueServices; query: string } }) =>
        input.services.list(input.query)
    ),
    loadIssue: fromPromise(
      ({ input }: { input: { services: LinearIssueServices; issueId: string } }) =>
        input.services.get(input.issueId)
    ),
    createIssue: fromPromise(
      ({ input }: { input: { services: LinearIssueServices; issue: CreateLinearIssueInput } }) =>
        input.services.create(input.issue)
    ),
    linkIssue: fromPromise(
      async ({ input }: { input: { services: LinearIssueServices; issue?: IssueReference } }) => {
        if (!input.issue) throw new Error("Choose a Linear issue to link.")
        await input.services.link(input.issue)
        return input.issue
      }
    ),
    addComment: fromPromise(
      ({ input }: { input: { services: LinearIssueServices; issueId: string; body: string } }) =>
        input.services.comment(input.issueId, input.body)
    ),
    unlinkIssue: fromPromise(
      ({ input }: { input: { services: LinearIssueServices } }) => input.services.unlink()
    )
  },
  guards: {
    hasLinkedIssue: ({ context }) => context.linkedIssue?.providerId === "linear",
    hasLoadedIssue: ({ context }) => context.issue !== null,
    hasWorkspace: ({ context }) => context.workspace !== null,
    canCreate: ({ context }) =>
      context.createInput.teamId.trim().length > 0 && context.createInput.title.trim().length > 0,
    canComment: ({ context }) => context.commentBody.trim().length > 0
  },
  actions: {
    clearError: assign({ error: null }),
    clearComment: assign({ commentBody: "" }),
    clearLink: assign({ linkedIssue: undefined, issue: null, error: null })
  }
}).createMachine({
  id: "linearIssue",
  initial: "checkingConfiguration",
  context: ({ input }) => ({
    services: input.services,
    linkedIssue: input.linkedIssue,
    issue: null,
    workspace: null,
    results: [],
    query: "",
    createInput: { teamId: "", title: "", description: "" },
    commentBody: "",
    error: null
  }),
  states: {
    checkingConfiguration: {
      invoke: {
        src: "checkConfiguration",
        input: ({ context }) => ({ services: context.services }),
        onDone: [
          { guard: ({ event }) => !event.output, target: "needsConfiguration" },
          { guard: "hasLinkedIssue", target: "loadingIssue", actions: "clearError" },
          { target: "loadingContext", actions: "clearError" }
        ],
        onError: {
          target: "error",
          actions: assign({ error: ({ event }) => message(event.error) })
        }
      }
    },
    loadingContext: {
      invoke: {
        src: "loadContext",
        input: ({ context }) => ({ services: context.services }),
        onDone: {
          target: "unlinked",
          actions: assign({
            workspace: ({ event }) => event.output,
            createInput: ({ context, event }) => ({
              ...context.createInput,
              teamId: context.createInput.teamId || event.output.teams[0]?.id || ""
            }),
            error: null
          })
        },
        onError: {
          target: "error",
          actions: assign({ error: ({ event }) => message(event.error) })
        }
      }
    },
    needsConfiguration: {
      on: { CONFIGURATION_CHANGED: "checkingConfiguration" }
    },
    unlinked: {
      on: {
        SEARCH_CHANGED: { actions: assign({ query: ({ event }) => event.query }) },
        SEARCH: { target: "searching", actions: "clearError" },
        LINK: {
          target: "linking",
          actions: assign({ linkedIssue: ({ event }) => referenceOf(event.issue) })
        },
        CREATE_CHANGED: {
          actions: assign({
            createInput: ({ context, event }) => ({
              ...context.createInput,
              [event.field]: event.value
            })
          })
        },
        CREATE_SUBMIT: { guard: "canCreate", target: "creating", actions: "clearError" }
      }
    },
    searching: {
      invoke: {
        src: "searchIssues",
        input: ({ context }) => ({ services: context.services, query: context.query }),
        onDone: {
          target: "unlinked",
          actions: assign({ results: ({ event }) => event.output, error: null })
        },
        onError: {
          target: "unlinked",
          actions: assign({ error: ({ event }) => message(event.error) })
        }
      }
    },
    creating: {
      invoke: {
        src: "createIssue",
        input: ({ context }) => ({ services: context.services, issue: context.createInput }),
        onDone: {
          target: "linking",
          actions: assign({ linkedIssue: ({ event }) => referenceOf(event.output), error: null })
        },
        onError: {
          target: "unlinked",
          actions: assign({ error: ({ event }) => message(event.error) })
        }
      }
    },
    linking: {
      invoke: {
        src: "linkIssue",
        input: ({ context }) => ({
          services: context.services,
          issue: context.linkedIssue
        }),
        onDone: {
          target: "loadingIssue",
          actions: assign({ linkedIssue: ({ event }) => event.output, error: null })
        },
        onError: {
          target: "unlinked",
          actions: assign({
            linkedIssue: undefined,
            error: ({ event }) => message(event.error)
          })
        }
      }
    },
    loadingIssue: {
      invoke: {
        src: "loadIssue",
        input: ({ context }) => ({
          services: context.services,
          issueId: context.linkedIssue?.id ?? ""
        }),
        onDone: {
          target: "detail",
          actions: assign({ issue: ({ event }) => event.output, error: null })
        },
        onError: [
          {
            guard: "hasLoadedIssue",
            target: "detail",
            actions: assign({ error: ({ event }) => message(event.error) })
          },
          {
            target: "error",
            actions: assign({ error: ({ event }) => message(event.error) })
          }
        ]
      }
    },
    detail: {
      on: {
        REFRESH: { target: "loadingIssue", actions: "clearError" },
        COMMENT_CHANGED: { actions: assign({ commentBody: ({ event }) => event.body }) },
        COMMENT_SUBMIT: { guard: "canComment", target: "commenting", actions: "clearError" },
        UNLINK: "unlinking"
      }
    },
    commenting: {
      invoke: {
        src: "addComment",
        input: ({ context }) => ({
          services: context.services,
          issueId: context.linkedIssue?.id ?? "",
          body: context.commentBody.trim()
        }),
        onDone: { target: "loadingIssue", actions: "clearComment" },
        onError: {
          target: "detail",
          actions: assign({ error: ({ event }) => message(event.error) })
        }
      }
    },
    unlinking: {
      invoke: {
        src: "unlinkIssue",
        input: ({ context }) => ({ services: context.services }),
        onDone: [
          { guard: "hasWorkspace", target: "unlinked", actions: "clearLink" },
          { target: "loadingContext", actions: "clearLink" }
        ],
        onError: [
          {
            guard: "hasLoadedIssue",
            target: "detail",
            actions: assign({ error: ({ event }) => message(event.error) })
          },
          {
            target: "error",
            actions: assign({ error: ({ event }) => message(event.error) })
          }
        ]
      }
    },
    error: {
      on: {
        RETRY: "checkingConfiguration",
        UNLINK: { guard: "hasLinkedIssue", target: "unlinking" }
      }
    }
  }
})
