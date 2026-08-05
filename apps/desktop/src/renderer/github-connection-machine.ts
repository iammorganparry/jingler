import type {
  GitHubAppConnectionStatus,
  GitHubConnection,
  GitHubRepositoryAccess
} from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"
import { rpc } from "./rpc-client.js"

export const EMPTY_GITHUB_CONNECTION: GitHubConnection = {
  mode: "disconnected",
  enabled: true,
  connected: false,
  user: null,
  installations: [],
  lastRefreshedAt: null,
  error: null
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Fold server facts into the six user-facing installation modes. */
export const connectionFromStatus = (status: GitHubAppConnectionStatus): GitHubConnection => {
  if (!status.enabled) {
    return {
      ...status,
      mode: "error",
      error: "GitHub App connections are not available on this Jingler server."
    }
  }
  if (!status.connected || status.user === null) {
    return { ...status, mode: "disconnected", error: null }
  }
  const active = status.installations.filter((installation) => installation.status === "active")
  const suspended = status.installations.filter(
    (installation) => installation.status === "suspended"
  )
  if (active.length === 0 && suspended.length > 0) {
    return { ...status, mode: "suspended", error: null }
  }
  if (
    active.length === 0 ||
    suspended.length > 0 ||
    active.some((installation) => installation.repositorySelection === "selected")
  ) {
    return { ...status, mode: "partial-access", error: null }
  }
  return { ...status, mode: "connected", error: null }
}

/**
 * Resolve one local GitHub repository against identities proven by the live
 * installation status. New sessions can supply the immutable repository id;
 * historical sessions fall back to an exact canonical full-name match against
 * that same GitHub-returned repository list.
 */
export const repositoryAccess = (
  connection: GitHubConnection,
  githubSlug: string | null,
  githubRepositoryId: string | null = null
): GitHubRepositoryAccess => {
  if (!githubSlug) {
    return {
      status: "unavailable",
      installationId: null,
      accountLogin: null,
      reason: "This repository has no GitHub remote."
    }
  }
  const canonicalSlug = githubSlug.toLowerCase()
  const owner = githubSlug.split("/")[0]?.toLowerCase() ?? ""
  const candidates = connection.installations.filter(
    (installation) => installation.account.login.toLowerCase() === owner
  )
  const activeInstallations = connection.installations.filter(
    (installation) => installation.status === "active"
  )
  const selected = activeInstallations.find((installation) =>
    (installation.repositories ?? []).some((repository) =>
      githubRepositoryId !== null
        ? repository.id === githubRepositoryId
        : repository.fullName.toLowerCase() === canonicalSlug
    )
  )
  if (selected) {
    return {
      status: "accessible",
      installationId: selected.id,
      accountLogin: selected.account.login,
      reason: `${githubSlug} is selected for the @${selected.account.login} installation.`
    }
  }
  const all = candidates.find(
    (installation) =>
      installation.status === "active" && installation.repositorySelection === "all"
  )
  if (all) {
    return {
      status: "accessible",
      installationId: all.id,
      accountLogin: all.account.login,
      reason: `The @${all.account.login} installation can access all repositories.`
    }
  }
  const partial = candidates.find((installation) => installation.status === "active")
  if (partial) {
    return {
      status: "partial",
      installationId: partial.id,
      accountLogin: partial.account.login,
      reason: `${githubSlug} is not included in the @${partial.account.login} installation's selected repositories.`
    }
  }
  const suspended = candidates[0]
  if (suspended) {
    return {
      status: "suspended",
      installationId: suspended.id,
      accountLogin: suspended.account.login,
      reason: `The GitHub App installation for @${suspended.account.login} is suspended.`
    }
  }
  return {
    status: "unavailable",
    installationId: null,
    accountLogin: null,
    reason: `${githubSlug} is outside the repositories available to the GitHub App.`
  }
}

const loadStatus = fromPromise(() => rpc.githubConnectionStatus())
const refreshStatus = fromPromise(() => rpc.githubConnectionRefresh())
const openInstall = fromPromise(async () => {
  const url = await rpc.githubConnectionInstall()
  await window.jingler.openExternal(url)
})
const disconnect = fromPromise(() => rpc.githubConnectionDisconnect())

export interface GitHubConnectionContext {
  readonly connection: GitHubConnection
}

export const githubConnectionMachine = setup({
  types: {
    context: {} as GitHubConnectionContext,
    events: {} as
      | { type: "CONNECT" }
      | { type: "MANAGE" }
      | { type: "REFRESH" }
      | { type: "DISCONNECT" }
      | { type: "CALLBACK"; ok: boolean; error: string | null }
      | { type: "RETRY" }
  },
  actors: { loadStatus, refreshStatus, openInstall, disconnect },
  actions: {
    assignStatus: assign({
      connection: ({ context, event }) =>
        "output" in event
          ? connectionFromStatus(event.output as GitHubAppConnectionStatus)
          : context.connection
    }),
    assignFailure: assign({
      connection: ({ context, event }) =>
        "error" in event
          ? {
              ...context.connection,
              mode: "error" as const,
              error: messageOf(event.error)
            }
          : context.connection
    })
  },
  guards: {
    isDisconnected: ({ context }) => context.connection.mode === "disconnected",
    isConnected: ({ context }) => context.connection.mode === "connected",
    isPartial: ({ context }) => context.connection.mode === "partial-access",
    isSuspended: ({ context }) => context.connection.mode === "suspended"
  }
}).createMachine({
  id: "github-connection",
  initial: "loading",
  context: { connection: EMPTY_GITHUB_CONNECTION },
  states: {
    loading: {
      invoke: {
        src: "loadStatus",
        onDone: { target: "sync", actions: "assignStatus" },
        onError: { target: "error", actions: "assignFailure" }
      }
    },
    sync: {
      always: [
        { guard: "isDisconnected", target: "disconnected" },
        { guard: "isConnected", target: "connected" },
        { guard: "isPartial", target: "partialAccess" },
        { guard: "isSuspended", target: "suspended" },
        { target: "error" }
      ]
    },
    disconnected: {
      on: {
        CONNECT: "connecting",
        REFRESH: "refreshing",
        RETRY: "loading"
      }
    },
    connecting: {
      entry: assign({
        connection: ({ context }) => ({ ...context.connection, mode: "connecting", error: null })
      }),
      invoke: {
        src: "openInstall",
        onError: { target: "error", actions: "assignFailure" }
      },
      on: {
        CALLBACK: [
          { guard: ({ event }) => event.ok, target: "refreshing" },
          {
            target: "error",
            actions: assign({
              connection: ({ context, event }) => ({
                ...context.connection,
                mode: "error",
                error: event.error ?? "GitHub did not complete the connection."
              })
            })
          }
        ],
        REFRESH: "refreshing"
      }
    },
    refreshing: {
      invoke: {
        src: "refreshStatus",
        onDone: { target: "sync", actions: "assignStatus" },
        onError: { target: "error", actions: "assignFailure" }
      }
    },
    disconnecting: {
      invoke: {
        src: "disconnect",
        onDone: {
          target: "disconnected",
          actions: assign({ connection: EMPTY_GITHUB_CONNECTION })
        },
        onError: { target: "error", actions: "assignFailure" }
      }
    },
    connected: {
      on: { MANAGE: "connecting", REFRESH: "refreshing", DISCONNECT: "disconnecting" }
    },
    partialAccess: {
      on: { MANAGE: "connecting", REFRESH: "refreshing", DISCONNECT: "disconnecting" }
    },
    suspended: {
      on: { MANAGE: "connecting", REFRESH: "refreshing", DISCONNECT: "disconnecting" }
    },
    error: {
      on: {
        CONNECT: "connecting",
        MANAGE: "connecting",
        REFRESH: "refreshing",
        DISCONNECT: "disconnecting",
        RETRY: "loading"
      }
    }
  }
})
