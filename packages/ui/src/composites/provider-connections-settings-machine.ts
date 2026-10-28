import type { ProviderConnectionId } from "@jingler/core"
import { assign, setup } from "xstate"

interface ProviderConnectionsSettingsInput {
  readonly connectionIds: ReadonlyArray<ProviderConnectionId>
  readonly defaultConnectionId: ProviderConnectionId | null
}

interface ProviderConnectionsSettingsContext {
  readonly knownIds: ReadonlyArray<ProviderConnectionId>
  readonly selectedId: ProviderConnectionId | null
  /** OAuth login id for the in-flight device/browser login, set while waiting. */
  readonly oauthLoginId: string | null
  /** Last-typed API key value; kept on an invalid-key error instead of being cleared. */
  readonly apiKeyValue: string
  readonly apiKeyError: string | null
}

type ProviderConnectionsSettingsEvent =
  | { readonly type: "ADD" }
  | { readonly type: "SELECT"; readonly connectionId: ProviderConnectionId }
  | {
      readonly type: "CATALOG_UPDATED"
      readonly connectionIds: ReadonlyArray<ProviderConnectionId>
    }
  | { readonly type: "START_OAUTH"; readonly loginId: string }
  | { readonly type: "CANCEL" }
  | { readonly type: "SUBMIT_API_KEY"; readonly value: string }
  | { readonly type: "API_KEY_INVALID"; readonly error: string }
  | { readonly type: "API_KEY_VERIFIED" }

const addedConnectionId = (
  knownIds: ReadonlyArray<ProviderConnectionId>,
  connectionIds: ReadonlyArray<ProviderConnectionId>
): ProviderConnectionId | null =>
  connectionIds.find((connectionId) => !knownIds.includes(connectionId)) ?? null

export const providerConnectionsSettingsMachine = setup({
  types: {
    context: {} as ProviderConnectionsSettingsContext,
    events: {} as ProviderConnectionsSettingsEvent,
    input: {} as ProviderConnectionsSettingsInput
  },
  guards: {
    hasAddedConnection: ({ context, event }) =>
      event.type === "CATALOG_UPDATED" &&
      addedConnectionId(context.knownIds, event.connectionIds) !== null,
    hasNoConnections: ({ event }) =>
      event.type === "CATALOG_UPDATED" && event.connectionIds.length === 0
  },
  actions: {
    beginAdding: assign({ selectedId: null }),
    selectConnection: assign(({ event }) =>
      event.type === "SELECT" ? { selectedId: event.connectionId } : {}
    ),
    selectAddedConnection: assign(({ context, event }) => {
      if (event.type !== "CATALOG_UPDATED") return {}
      return {
        knownIds: event.connectionIds,
        selectedId: addedConnectionId(context.knownIds, event.connectionIds)
      }
    }),
    clearConnections: assign(({ event }) =>
      event.type === "CATALOG_UPDATED"
        ? { knownIds: event.connectionIds, selectedId: null }
        : {}
    ),
    syncConnections: assign(({ context, event }) => {
      if (event.type !== "CATALOG_UPDATED") return {}
      return {
        knownIds: event.connectionIds,
        selectedId:
          context.selectedId === null
            ? null
            : event.connectionIds.includes(context.selectedId)
              ? context.selectedId
              : (event.connectionIds[0] ?? null)
      }
    }),
    beginOauth: assign(({ event }) =>
      event.type === "START_OAUTH" ? { oauthLoginId: event.loginId } : {}
    ),
    clearOauth: assign({ oauthLoginId: null }),
    /** No-op by default; the host composite `.provide()`s this to call the Provider.cancelLogin RPC. */
    cancelLogin: () => {},
    setApiKeyValue: assign(({ event }) =>
      event.type === "SUBMIT_API_KEY" ? { apiKeyValue: event.value, apiKeyError: null } : {}
    ),
    setApiKeyError: assign(({ event }) =>
      event.type === "API_KEY_INVALID" ? { apiKeyError: event.error } : {}
    ),
    clearApiKey: assign({ apiKeyValue: "", apiKeyError: null })
  }
}).createMachine({
  id: "provider-connections-settings",
  initial: "routing",
  context: ({ input }) => ({
    knownIds: input.connectionIds,
    selectedId:
      input.defaultConnectionId !== null && input.connectionIds.includes(input.defaultConnectionId)
        ? input.defaultConnectionId
        : (input.connectionIds[0] ?? null),
    oauthLoginId: null,
    apiKeyValue: "",
    apiKeyError: null
  }),
  on: {
    CATALOG_UPDATED: [
      {
        guard: "hasAddedConnection",
        target: ".browsing",
        actions: "selectAddedConnection"
      },
      {
        guard: "hasNoConnections",
        target: ".adding",
        actions: "clearConnections"
      },
      { actions: "syncConnections" }
    ],
    SUBMIT_API_KEY: { actions: "setApiKeyValue" },
    API_KEY_INVALID: { actions: "setApiKeyError" },
    API_KEY_VERIFIED: { actions: "clearApiKey" }
  },
  states: {
    routing: {
      always: [
        { guard: ({ context }) => context.knownIds.length === 0, target: "adding" },
        { target: "browsing" }
      ]
    },
    browsing: {
      on: {
        ADD: { target: "adding", actions: "beginAdding" },
        SELECT: { actions: "selectConnection" },
        START_OAUTH: { target: "oauthWaitingFromBrowsing", actions: "beginOauth" }
      }
    },
    adding: {
      on: {
        SELECT: { target: "browsing", actions: "selectConnection" },
        START_OAUTH: { target: "oauthWaitingFromAdding", actions: "beginOauth" }
      }
    },
    oauthWaitingFromBrowsing: {
      on: {
        CANCEL: { target: "browsing", actions: ["cancelLogin", "clearOauth"] }
      }
    },
    oauthWaitingFromAdding: {
      on: {
        CANCEL: { target: "adding", actions: ["cancelLogin", "clearOauth"] }
      }
    }
  }
})
