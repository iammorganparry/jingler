import {
  DEFAULT_OFFLOAD_COMPUTE_SETTINGS,
  type OffloadComputeSettings
} from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export interface OffloadSettingsApi {
  readonly save: (
    settings: OffloadComputeSettings
  ) => Promise<OffloadComputeSettings>
}

interface OffloadSettingsContext {
  readonly settings: OffloadComputeSettings
  readonly pending: OffloadComputeSettings | null
  readonly error: string | null
}

type OffloadSettingsEvent =
  | { readonly type: "SYNC"; readonly settings: OffloadComputeSettings }
  | { readonly type: "SET"; readonly settings: OffloadComputeSettings }
  | { readonly type: "RETRY" }

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Offload Compute settings could not be saved."

export const createOffloadSettingsMachine = (api: OffloadSettingsApi) =>
  setup({
    types: {
      context: {} as OffloadSettingsContext,
      events: {} as OffloadSettingsEvent
    },
    actors: {
      save: fromPromise(({ input }: { input: OffloadComputeSettings }) => api.save(input))
    }
  }).createMachine({
    id: "offload-settings",
    initial: "idle",
    context: {
      settings: DEFAULT_OFFLOAD_COMPUTE_SETTINGS,
      pending: null,
      error: null
    },
    on: {
      SYNC: {
        actions: assign({
          settings: ({ event }) => event.settings,
          error: null
        })
      }
    },
    states: {
      idle: {
        on: {
          SET: {
            target: "saving",
            actions: assign({
              pending: ({ event }) => event.settings,
              settings: ({ event }) => event.settings,
              error: null
            })
          }
        }
      },
      saving: {
        invoke: {
          src: "save",
          input: ({ context }) => context.pending ?? context.settings,
          onDone: {
            target: "idle",
            actions: assign({
              settings: ({ event }) => event.output,
              pending: null,
              error: null
            })
          },
          onError: {
            target: "failed",
            actions: assign({
              error: ({ event }) => messageOf(event.error)
            })
          }
        }
      },
      failed: {
        on: {
          SET: {
            target: "saving",
            actions: assign({
              pending: ({ event }) => event.settings,
              settings: ({ event }) => event.settings,
              error: null
            })
          },
          RETRY: {
            target: "saving",
            guard: ({ context }) => context.pending !== null
          }
        }
      }
    }
  })
