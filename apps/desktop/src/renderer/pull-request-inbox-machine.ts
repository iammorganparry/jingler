import type { GitHubCliAccount, GitHubTeam, GitHubTeamDiscovery, GitHubTeamQueue, PullRequestListItem } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

const STORAGE_PREFIX = "jingler.pr-inbox.team."
const validQueue = (value: unknown): value is GitHubTeamQueue =>
  value === "reviews" || value === "authored" || value === "repositories"

interface InboxContext {
  discover: () => Promise<GitHubTeamDiscovery>
  account: GitHubCliAccount | null
  teams: ReadonlyArray<GitHubTeam>
  teamId: string | null
  queue: GitHubTeamQueue
  selected: PullRequestListItem | null
  revision: number
  refreshDiscovery: boolean
  discoveryError: string | null
}

type InboxEvent =
  | { type: "DISCOVER" }
  | { type: "TEAM"; teamId: string | null }
  | { type: "QUEUE"; queue: GitHubTeamQueue }
  | { type: "SELECT"; pr: PullRequestListItem }

const restore = (account: GitHubCliAccount, teams: ReadonlyArray<GitHubTeam>) => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${account.id}`) ?? "null")
    if (typeof raw === "object" && raw !== null && "teamId" in raw && "queue" in raw) {
      const teamId = typeof raw.teamId === "string" && teams.some((team) => team.id === raw.teamId) ? raw.teamId : null
      return { teamId, queue: validQueue(raw.queue) ? raw.queue : "reviews" as const }
    }
  } catch { /* corrupt or unavailable local storage is not a membership source */ }
  return { teamId: null, queue: "reviews" as const }
}

const persist = (context: InboxContext): void => {
  if (context.account === null) return
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${context.account.id}`, JSON.stringify({ teamId: context.teamId, queue: context.queue }))
  } catch { /* storage is optional; credentials and membership are never persisted */ }
}

export const pullRequestInboxMachine = setup({
  types: {
    context: {} as InboxContext,
    events: {} as InboxEvent,
    input: {} as { discover: () => Promise<GitHubTeamDiscovery> },
  },
  actors: {
    discover: fromPromise<GitHubTeamDiscovery, { discover: () => Promise<GitHubTeamDiscovery> }>(({ input }) => input.discover()),
  },
  actions: { persist: ({ context }) => persist(context) },
}).createMachine({
  id: "pull-request-inbox",
  context: ({ input }) => ({
    discover: input.discover,
    account: null, teams: [], teamId: null, queue: "reviews", selected: null,
    revision: 0, refreshDiscovery: true, discoveryError: null,
  }),
  initial: "idle",
  on: {
    DISCOVER: {
      target: ".discovering",
      actions: assign({ selected: null, discoveryError: null, refreshDiscovery: true }),
    },
  },
  states: {
    idle: {},
    discovering: {
      invoke: {
        src: "discover",
        input: ({ context }) => ({ discover: context.discover }),
        onDone: {
          target: "ready",
          actions: [assign(({ context, event }) => ({
            account: event.output.account,
            teams: event.output.teams,
            ...restore(event.output.account, event.output.teams),
            revision: context.revision + 1,
            selected: null,
          })), "persist"],
        },
        onError: {
          target: "failed",
          actions: assign(({ context, event }) => ({
            selected: null,
            revision: context.revision + 1,
            discoveryError: event.error instanceof Error ? event.error.message :
              typeof event.error === "object" && event.error !== null && "message" in event.error && typeof event.error.message === "string"
                ? event.error.message : "GitHub CLI could not discover teams. Authenticate on github.com, then refresh.",
          })),
        },
      },
    },
    ready: {
      on: {
        TEAM: {
          actions: [assign(({ context, event }) => ({
            teamId: context.teams.some((team) => team.id === event.teamId) ? event.teamId : null,
            queue: "reviews" as const, selected: null, refreshDiscovery: false,
          })), "persist"],
        },
        QUEUE: {
          actions: [assign(({ event }) => ({ queue: event.queue, selected: null, refreshDiscovery: false })), "persist"],
        },
        SELECT: { actions: assign(({ event }) => ({ selected: event.pr })) },
      },
    },
    failed: {
      on: {
        TEAM: { actions: assign({ teamId: null, selected: null }) },
        SELECT: { actions: assign(({ event }) => ({ selected: event.pr })) },
      },
    },
  },
})
