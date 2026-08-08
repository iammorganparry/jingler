import type {
  Environment,
  PairSshEnvironmentInput,
  SshHost
} from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export interface EnvironmentMachineApi {
  suggestHosts: () => Promise<ReadonlyArray<SshHost>>
  pairSsh: (input: PairSshEnvironmentInput) => Promise<Environment>
}

export interface EnvironmentContext {
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

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "Could not connect this environment."

export const createEnvironmentMachine = (api: EnvironmentMachineApi) =>
  setup({
    types: {
      context: {} as EnvironmentContext,
      events: {} as EnvironmentEvent
    },
    actors: {
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
      hosts: [],
      host: "",
      environment: null,
      error: null
    },
    on: {
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
          host: event.host.alias
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
        on: { SUBMIT: { guard: "canSubmit", target: "claiming" } }
      },
      claiming: {
        invoke: {
          src: "pair",
          input: ({ context }) => context,
          onDone: {
            target: "connected",
            actions: assign({
              environment: ({ event }) => event.output,
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
