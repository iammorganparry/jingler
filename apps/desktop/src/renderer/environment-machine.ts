import type {
  Environment,
  PairLinkEnvironmentInput,
  PairSshEnvironmentInput,
  SshHost
} from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export interface EnvironmentMachineApi {
  suggestHosts: () => Promise<ReadonlyArray<SshHost>>
  pairLink: (input: PairLinkEnvironmentInput) => Promise<Environment>
  pairSsh: (input: PairSshEnvironmentInput) => Promise<Environment>
  revoke: (deviceId: string) => Promise<void>
}

export interface EnvironmentContext {
  method: "remote-link" | "ssh" | null
  hosts: ReadonlyArray<SshHost>
  backendUrl: string
  pendingDeviceId: string
  pairingCode: string
  host: string
  username: string
  port: string
  environment: Environment | null
  error: string | null
}

type EnvironmentEvent =
  | { type: "CHOOSE"; method: "remote-link" | "ssh" }
  | {
      type: "EDIT"
      field:
        | "backendUrl"
        | "pendingDeviceId"
        | "pairingCode"
        | "host"
        | "username"
        | "port"
      value: string
    }
  | { type: "SELECT_HOST"; host: SshHost }
  | { type: "SUBMIT" }
  | { type: "RETRY" }
  | { type: "RESET" }
  | { type: "CANCEL" }
  | { type: "REVOKE" }

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
      pair: fromPromise(({ input }: { input: EnvironmentContext }) => {
        if (input.method === "ssh") {
          return api.pairSsh({
            host: input.host,
            ...(input.username.trim()
              ? { username: input.username.trim() }
              : {}),
            ...(input.port.trim() ? { port: Number(input.port) } : {})
          })
        }
        return api.pairLink({
          backendUrl: input.backendUrl.trim(),
          pendingDeviceId: input.pendingDeviceId.trim(),
          pairingCode: input.pairingCode.trim().toUpperCase()
        })
      }),
      revoke: fromPromise(({ input }: { input: { deviceId: string } }) =>
        api.revoke(input.deviceId)
      )
    },
    guards: {
      canSubmit: ({ context }) =>
        context.method === "ssh"
          ? context.host.trim().length > 0 &&
            (!context.port.trim() || /^\d{1,5}$/u.test(context.port))
          : context.method === "remote-link" &&
            context.backendUrl.trim().length > 0 &&
            context.pendingDeviceId.trim().length > 0 &&
            context.pairingCode.trim().length > 0
    }
  }).createMachine({
    id: "environment",
    initial: "choosing",
    context: {
      method: null,
      hosts: [],
      backendUrl: "",
      pendingDeviceId: "",
      pairingCode: "",
      host: "",
      username: "",
      port: "22",
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
          host: event.host.alias,
          username: event.host.username ?? "",
          port: String(event.host.port)
        }))
      },
      CANCEL: {
        target: ".choosing",
        actions: assign({ method: null, error: null })
      },
      RESET: {
        target: ".choosing",
        actions: assign({ method: null, error: null, environment: null })
      }
    },
    states: {
      choosing: {
        on: {
          CHOOSE: [
            {
              guard: ({ event }) => event.method === "ssh",
              target: "discovering",
              actions: assign({ method: "ssh", error: null })
            },
            {
              target: "linking",
              actions: assign({ method: "remote-link", error: null })
            }
          ]
        }
      },
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
      linking: { on: { SUBMIT: { guard: "canSubmit", target: "claiming" } } },
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
      connected: {
        on: {
          REVOKE: {
            target: "revoking",
            guard: ({ context }) => context.environment !== null
          }
        }
      },
      revoking: {
        invoke: {
          src: "revoke",
          input: ({ context }) => ({ deviceId: context.environment?.id ?? "" }),
          onDone: {
            target: "choosing",
            actions: assign({ environment: null, method: null })
          },
          onError: {
            target: "failed",
            actions: assign({ error: ({ event }) => messageOf(event.error) })
          }
        }
      },
      failed: {
        on: {
          RETRY: [
            {
              guard: ({ context }) => context.method === "ssh",
              target: "configuring"
            },
            { target: "linking" }
          ]
        }
      }
    }
  })
