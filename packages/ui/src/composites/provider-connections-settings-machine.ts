import type { ProviderConnectionId } from "@jingler/core"
import { assign, setup } from "xstate"

interface ProviderConnectionsSettingsInput {
  readonly connectionIds: ReadonlyArray<ProviderConnectionId>
  readonly defaultConnectionId: ProviderConnectionId | null
}

interface ProviderConnectionsSettingsContext {
  readonly knownIds: ReadonlyArray<ProviderConnectionId>
  readonly selectedId: ProviderConnectionId | null
}

type ProviderConnectionsSettingsEvent =
  | { readonly type: "ADD" }
  | { readonly type: "SELECT"; readonly connectionId: ProviderConnectionId }
  | {
      readonly type: "CATALOG_UPDATED"
      readonly connectionIds: ReadonlyArray<ProviderConnectionId>
    }

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
    })
  }
}).createMachine({
  id: "provider-connections-settings",
  initial: "routing",
  context: ({ input }) => ({
    knownIds: input.connectionIds,
    selectedId:
      input.defaultConnectionId !== null && input.connectionIds.includes(input.defaultConnectionId)
        ? input.defaultConnectionId
        : (input.connectionIds[0] ?? null)
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
    ]
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
        SELECT: { actions: "selectConnection" }
      }
    },
    adding: {
      on: {
        SELECT: { target: "browsing", actions: "selectConnection" }
      }
    }
  }
})
