import type {
  Environment,
  PairSshEnvironmentInput,
  SshHost
} from "@jingler/core"
import { assign, fromCallback, fromPromise, sendTo, setup } from "xstate"

export interface EnvironmentMachineApi {
  list: () => Promise<ReadonlyArray<Environment>>
  refresh: () => Promise<ReadonlyArray<Environment>>
  watch: (
    onEnvironments: (environments: ReadonlyArray<Environment>) => void,
    onFailure: (error: unknown) => void
  ) => () => void
  suggestHosts: () => Promise<ReadonlyArray<SshHost>>
  pairSsh: (input: PairSshEnvironmentInput) => Promise<Environment>
  rename: (id: string, name: string) => Promise<Environment>
  revoke: (id: string) => Promise<void>
}

export interface EnvironmentContext {
  environments: ReadonlyArray<Environment>
  loading: boolean
  inventoryError: string | null
  hosts: ReadonlyArray<SshHost>
  host: string
  environment: Environment | null
  error: string | null
}

type EnvironmentEvent =
  | { type: "EDIT"; field: "host"; value: string }
  | { type: "SELECT_HOST"; host: SshHost }
  | { type: "SUBMIT" }
  | { type: "RETRY" }
  | { type: "RESET" }
  | { type: "CANCEL" }
  | { type: "REFRESH" }
  | { type: "RENAME"; id: string; name: string }
  | { type: "REVOKE"; id: string }
  | {
      type: "INVENTORY_LOADED"
      environments: ReadonlyArray<Environment>
    }
  | { type: "INVENTORY_FAILED"; error: unknown }
  | { type: "ENVIRONMENT_RENAMED"; environment: Environment }
  | { type: "ENVIRONMENT_REVOKED"; id: string }

type InventoryCommand = Extract<
  EnvironmentEvent,
  { type: "REFRESH" | "RENAME" | "REVOKE" }
>

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "Could not connect this environment."

const inventoryMessageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "Could not load devices."

const upsertEnvironment = (
  environments: ReadonlyArray<Environment>,
  environment: Environment
): ReadonlyArray<Environment> => {
  const index = environments.findIndex((item) => item.id === environment.id)
  if (index < 0) return [...environments, environment]
  return environments.map((item, itemIndex) =>
    itemIndex === index ? environment : item
  )
}

export const createEnvironmentMachine = (api: EnvironmentMachineApi) =>
  setup({
    types: {
      context: {} as EnvironmentContext,
      events: {} as EnvironmentEvent
    },
    actors: {
      inventory: fromCallback<InventoryCommand, undefined>(
        ({ sendBack, receive }) => {
          let active = true
          const load = async (
            operation: () => Promise<ReadonlyArray<Environment>>
          ): Promise<void> => {
            try {
              const environments = await operation()
              if (active)
                sendBack({ type: "INVENTORY_LOADED", environments })
            } catch (error) {
              if (active) sendBack({ type: "INVENTORY_FAILED", error })
            }
          }

          void load(api.list)
          const stopWatching = api.watch(
            (environments) =>
              sendBack({ type: "INVENTORY_LOADED", environments }),
            (error) => sendBack({ type: "INVENTORY_FAILED", error })
          )

          receive((event) => {
            if (event.type === "REFRESH") {
              void load(api.refresh)
              return
            }
            if (event.type === "RENAME") {
              void api
                .rename(event.id, event.name)
                .then((environment) => {
                  if (active)
                    sendBack({ type: "ENVIRONMENT_RENAMED", environment })
                })
                .catch((error: unknown) => {
                  if (active) sendBack({ type: "INVENTORY_FAILED", error })
                })
              return
            }
            void api
              .revoke(event.id)
              .then(() => {
                if (active)
                  sendBack({ type: "ENVIRONMENT_REVOKED", id: event.id })
              })
              .catch((error: unknown) => {
                if (active) sendBack({ type: "INVENTORY_FAILED", error })
              })
          })

          return () => {
            active = false
            stopWatching()
          }
        }
      ),
      discover: fromPromise(() => api.suggestHosts()),
      pair: fromPromise(({ input }: { input: EnvironmentContext }) =>
        api.pairSsh({ host: input.host.trim() })
      )
    },
    guards: {
      canSubmit: ({ context }) => context.host.trim().length > 0
    }
  }).createMachine({
    id: "environment",
    initial: "discovering",
    context: {
      environments: [],
      loading: true,
      inventoryError: null,
      hosts: [],
      host: "",
      environment: null,
      error: null
    },
    invoke: { id: "inventory", src: "inventory" },
    on: {
      INVENTORY_LOADED: {
        actions: assign({
          environments: ({ event }) => event.environments,
          loading: false,
          inventoryError: null
        })
      },
      INVENTORY_FAILED: {
        actions: assign({
          loading: false,
          inventoryError: ({ event }) => inventoryMessageOf(event.error)
        })
      },
      REFRESH: {
        actions: [
          assign({ loading: true, inventoryError: null }),
          sendTo("inventory", ({ event }) => event)
        ]
      },
      RENAME: {
        actions: sendTo("inventory", ({ event }) => event)
      },
      REVOKE: {
        actions: sendTo("inventory", ({ event }) => event)
      },
      ENVIRONMENT_RENAMED: {
        actions: assign({
          environments: ({ context, event }) =>
            upsertEnvironment(context.environments, event.environment),
          inventoryError: null
        })
      },
      ENVIRONMENT_REVOKED: {
        actions: assign({
          environments: ({ context, event }) =>
            context.environments.filter((item) => item.id !== event.id),
          inventoryError: null
        })
      },
      EDIT: {
        actions: assign(({ context, event }) => ({
          ...context,
          [event.field]: event.value,
          error: null
        }))
      },
      SELECT_HOST: {
        actions: assign(({ event }) => ({
          // OpenSSH remains authoritative for User, HostName, Port,
          // identities, proxies, and agent configuration.
          host: event.host.alias,
          error: null
        }))
      },
      CANCEL: {
        actions: assign({ error: null })
      },
      RESET: {
        target: ".discovering",
        reenter: true,
        actions: assign({ host: "", error: null, environment: null })
      }
    },
    states: {
      discovering: {
        invoke: {
          src: "discover",
          onDone: {
            target: "configuring",
            actions: assign({ hosts: ({ event }) => event.output })
          },
          onError: {
            target: "failed",
            actions: assign({ error: ({ event }) => messageOf(event.error) })
          }
        }
      },
      configuring: {
        on: { SUBMIT: { guard: "canSubmit", target: "enrolling" } }
      },
      enrolling: {
        invoke: {
          src: "pair",
          input: ({ context }) => context,
          onDone: {
            target: "connected",
            actions: assign({
              environment: ({ event }) => event.output,
              environments: ({ context, event }) =>
                upsertEnvironment(context.environments, event.output),
              error: null
            })
          },
          onError: {
            target: "failed",
            actions: assign({ error: ({ event }) => messageOf(event.error) })
          }
        }
      },
      connected: {},
      failed: {
        on: {
          RETRY: { target: "configuring" }
        }
      }
    }
  })
