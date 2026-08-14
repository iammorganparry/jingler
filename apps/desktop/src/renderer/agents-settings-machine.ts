import type {
  DetectedResourceCandidate,
  ManagedResource,
  ManagedResourceSelector,
  ResourceDetectionResult,
  ResourceImportResult
} from "@jingler/core"
import { assign, fromCallback, fromPromise, setup } from "xstate"

export interface AgentsSettingsApi {
  readonly list: () => Promise<ReadonlyArray<ManagedResource>>
  readonly detect: () => Promise<ResourceDetectionResult>
  readonly importFiles: (
    candidates: ReadonlyArray<DetectedResourceCandidate>
  ) => Promise<ResourceImportResult>
  readonly setEnabled: (selector: ManagedResourceSelector, enabled: boolean) => Promise<void>
  readonly remove: (selector: ManagedResourceSelector) => Promise<void>
  readonly reveal: (selector: ManagedResourceSelector) => Promise<void>
  readonly watch: (
    listener: (resources: ReadonlyArray<ManagedResource>) => void
  ) => () => void
}

export interface PendingResourceAction {
  readonly kind: "enable" | "remove" | "reveal"
  readonly selector: ManagedResourceSelector
  readonly enabled?: boolean
}

export interface AgentsSettingsContext {
  readonly resources: ReadonlyArray<ManagedResource>
  readonly detection: ResourceDetectionResult | null
  readonly selectedCandidateIds: ReadonlySet<string>
  readonly pending: PendingResourceAction | null
  readonly error: string | null
}

export type AgentsSettingsEvent =
  | { readonly type: "DETECT" }
  | { readonly type: "CANCEL_DETECTION" }
  | { readonly type: "TOGGLE_CANDIDATE"; readonly id: string }
  | { readonly type: "IMPORT_SELECTED" }
  | { readonly type: "SET_ENABLED"; readonly selector: ManagedResourceSelector; readonly enabled: boolean }
  | { readonly type: "REMOVE"; readonly selector: ManagedResourceSelector }
  | { readonly type: "REVEAL"; readonly selector: ManagedResourceSelector }
  | { readonly type: "RETRY" }
  | { readonly type: "WATCHED"; readonly resources: ReadonlyArray<ManagedResource> }

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "Managed resources are unavailable."

const selectedCandidates = (
  context: AgentsSettingsContext
): ReadonlyArray<DetectedResourceCandidate> =>
  context.detection?.candidates.filter(({ id }) => context.selectedCandidateIds.has(id)) ?? []

export const createAgentsSettingsMachine = (api: AgentsSettingsApi) =>
  setup({
    types: {
      context: {} as AgentsSettingsContext,
      events: {} as AgentsSettingsEvent
    },
    actors: {
      list: fromPromise(() => api.list()),
      detect: fromPromise(() => api.detect()),
      importSelected: fromPromise(({ input }: { input: AgentsSettingsContext }) =>
        api.importFiles(selectedCandidates(input))
      ),
      mutate: fromPromise(async ({ input }: { input: PendingResourceAction }) => {
        if (input.kind === "enable") {
          await api.setEnabled(input.selector, input.enabled === true)
        } else if (input.kind === "remove") {
          await api.remove(input.selector)
        } else {
          await api.reveal(input.selector)
        }
      }),
      watch: fromCallback(({ sendBack }) =>
        api.watch((resources) => sendBack({ type: "WATCHED", resources }))
      )
    },
    guards: {
      hasSelection: ({ context }) => selectedCandidates(context).length > 0
    }
  }).createMachine({
    id: "agents-settings",
    initial: "loading",
    context: {
      resources: [],
      detection: null,
      selectedCandidateIds: new Set(),
      pending: null,
      error: null
    },
    invoke: { src: "watch" },
    on: {
      WATCHED: {
        actions: assign({ resources: ({ event }) => event.resources })
      }
    },
    states: {
      loading: {
        invoke: {
          src: "list",
          onDone: {
            target: "ready",
            actions: assign({ resources: ({ event }) => event.output, error: null })
          },
          onError: {
            target: "failed",
            actions: assign({ error: ({ event }) => messageOf(event.error) })
          }
        }
      },
      ready: {
        on: {
          DETECT: { target: "detecting", actions: assign({ error: null }) },
          SET_ENABLED: {
            target: "mutating",
            actions: assign({
              pending: ({ event }) => ({ kind: "enable", selector: event.selector, enabled: event.enabled }),
              error: null
            })
          },
          REMOVE: {
            target: "mutating",
            actions: assign({ pending: ({ event }) => ({ kind: "remove", selector: event.selector }), error: null })
          },
          REVEAL: {
            target: "mutating",
            actions: assign({ pending: ({ event }) => ({ kind: "reveal", selector: event.selector }), error: null })
          }
        }
      },
      detecting: {
        invoke: {
          src: "detect",
          onDone: {
            target: "reviewing",
            actions: assign({
              detection: ({ event }) => event.output,
              selectedCandidateIds: ({ event }) =>
                new Set(event.output.candidates.map(({ id }) => id)),
              error: null
            })
          },
          onError: {
            target: "ready",
            actions: assign({ error: ({ event }) => messageOf(event.error) })
          }
        }
      },
      reviewing: {
        on: {
          TOGGLE_CANDIDATE: {
            actions: assign({
              selectedCandidateIds: ({ context, event }) => {
                const next = new Set(context.selectedCandidateIds)
                if (next.has(event.id)) next.delete(event.id)
                else next.add(event.id)
                return next
              }
            })
          },
          IMPORT_SELECTED: { target: "importing", guard: "hasSelection" },
          CANCEL_DETECTION: {
            target: "ready",
            actions: assign({ detection: null, selectedCandidateIds: new Set(), error: null })
          }
        }
      },
      importing: {
        invoke: {
          src: "importSelected",
          input: ({ context }) => context,
          onDone: {
            target: "loading",
            actions: assign({ detection: null, selectedCandidateIds: new Set(), error: null })
          },
          onError: {
            target: "reviewing",
            actions: assign({ error: ({ event }) => messageOf(event.error) })
          }
        }
      },
      mutating: {
        invoke: {
          src: "mutate",
          input: ({ context }) => {
            if (context.pending === null) throw new Error("Resource action is missing")
            return context.pending
          },
          onDone: { target: "loading", actions: assign({ pending: null, error: null }) },
          onError: {
            target: "ready",
            actions: assign({ pending: null, error: ({ event }) => messageOf(event.error) })
          }
        }
      },
      failed: { on: { RETRY: "loading" } }
    }
  })
