import { assign, fromPromise, setup } from "xstate"

/** `claude-cli` checks the local `claude auth login`; Jingler never reads its credentials. */
export type LoginMethod = "browser" | "device-code" | "claude-cli"

export type SaveApiKeyResult = { ok: true } | { ok: false; error: string }

export interface ProviderConnectContext {
  readonly method: LoginMethod
  /** Provider the API key is for; locked to one on reconnect. */
  readonly apiProvider: string
  /** Typed key; kept after a rejection so the user can fix it in place. */
  readonly apiKey: string
  readonly error: string | null
}

type ProviderConnectEvent =
  | { readonly type: "SELECT_SUBSCRIPTION" }
  | { readonly type: "SELECT_API_KEY" }
  | { readonly type: "START"; readonly method: LoginMethod }
  | { readonly type: "REOPEN_BROWSER" }
  | { readonly type: "CANCEL" }
  | { readonly type: "EDIT_API_PROVIDER"; readonly value: string }
  | { readonly type: "EDIT_API_KEY"; readonly value: string }
  | { readonly type: "SUBMIT_API_KEY" }
  | { readonly type: "DONE" }

const notProvided = (name: string) => () => Promise.reject(new Error(`${name} was not provided`))
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const initialProviderConnectContext: ProviderConnectContext = {
  method: "browser",
  apiProvider: "anthropic",
  apiKey: "",
  error: null
}

/**
 * Boards 15a–15c. `connecting` lasts for the whole login (the start RPC resolves only once the
 * provider confirms), so the waiting card shows until it connects, fails, or is cancelled.
 */
export const providerConnectMachine = setup({
  types: {
    context: {} as ProviderConnectContext,
    events: {} as ProviderConnectEvent,
    input: {} as { readonly apiProvider?: string } | undefined
  },
  actors: {
    login: fromPromise<void, { method: LoginMethod }>(notProvided("login")),
    cancelLogin: fromPromise<void>(notProvided("cancelLogin")),
    saveApiKey: fromPromise<SaveApiKeyResult, { providerId: string; apiKey: string }>(notProvided("saveApiKey"))
  },
  actions: {
    reopenBrowser: () => {},
    connected: () => {},
    close: () => {},
    clearError: assign({ error: null }),
    editApiKey: assign(({ event }) => (event.type === "EDIT_API_KEY" ? { apiKey: event.value, error: null } : {})),
    editApiProvider: assign(({ event }) =>
      event.type === "EDIT_API_PROVIDER" ? { apiProvider: event.value, error: null } : {}
    )
  },
  guards: {
    hasApiKey: ({ context }) => context.apiKey.trim().length > 0
  }
}).createMachine({
  id: "provider-connect",
  initial: "subscription",
  context: ({ input }) => ({
    ...initialProviderConnectContext,
    apiProvider: input?.apiProvider ?? initialProviderConnectContext.apiProvider
  }),
  states: {
    subscription: {
      initial: "idle",
      states: {
        idle: {
          on: {
            START: { target: "connecting", actions: assign({ method: ({ event }) => event.method, error: null }) },
            SELECT_API_KEY: { target: "#provider-connect.apiKey", actions: "clearError" }
          }
        },
        connecting: {
          invoke: {
            src: "login",
            input: ({ context }) => ({ method: context.method }),
            onDone: "connected",
            onError: { target: "idle", actions: assign({ error: ({ event }) => errorMessage(event.error) }) }
          },
          on: {
            REOPEN_BROWSER: { actions: "reopenBrowser" },
            CANCEL: "cancelling"
          }
        },
        cancelling: {
          invoke: { src: "cancelLogin", onDone: "idle", onError: "idle" }
        },
        connected: { entry: ["connected", "close"] }
      }
    },
    apiKey: {
      initial: "editing",
      states: {
        editing: {
          on: {
            SELECT_SUBSCRIPTION: "#provider-connect.subscription",
            EDIT_API_PROVIDER: { actions: "editApiProvider" },
            EDIT_API_KEY: { actions: "editApiKey" },
            SUBMIT_API_KEY: { guard: "hasApiKey", target: "verifying" }
          }
        },
        verifying: {
          invoke: {
            src: "saveApiKey",
            input: ({ context }) => ({ providerId: context.apiProvider, apiKey: context.apiKey.trim() }),
            onDone: [
              { guard: ({ event }) => event.output.ok, target: "verified" },
              { target: "invalid", actions: assign({ error: ({ event }) => (event.output.ok ? null : event.output.error) }) }
            ],
            onError: { target: "invalid", actions: assign({ error: ({ event }) => errorMessage(event.error) }) }
          }
        },
        invalid: {
          on: {
            SELECT_SUBSCRIPTION: { target: "#provider-connect.subscription", actions: "clearError" },
            EDIT_API_PROVIDER: { target: "editing", actions: "editApiProvider" },
            EDIT_API_KEY: { target: "editing", actions: "editApiKey" },
            SUBMIT_API_KEY: { guard: "hasApiKey", target: "verifying" }
          }
        },
        verified: {
          entry: "connected",
          on: { DONE: { actions: "close" } }
        }
      }
    }
  }
})

type ProviderConnectStateValue = Parameters<typeof providerConnectMachine.resolveState>[0]["value"]

/** Starts the sheet in a given state; stories use it to open straight on a board. */
export const providerConnectSnapshot = (
  value: ProviderConnectStateValue,
  context: Partial<ProviderConnectContext> = {}
) => providerConnectMachine.resolveState({ value, context: { ...initialProviderConnectContext, ...context } })

export type ProviderConnectSnapshot = ReturnType<typeof providerConnectSnapshot>
