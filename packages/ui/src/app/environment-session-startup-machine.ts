import type { Environment } from "@jingler/core"
import type { SessionCreationPhase } from "@jingler/contracts"
import { assign, setup } from "xstate"

export interface PendingEnvironmentSession {
  readonly id: string
  readonly title: string
  readonly repo: string
  readonly environmentId: string
  readonly environmentName: string
  readonly environmentKind: Environment["kind"]
  readonly phase: SessionCreationPhase
  readonly error: string | null
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export const environmentSessionStartupMachine = setup({
  types: {
    context: {} as { pending: PendingEnvironmentSession | null },
    events: {} as
      | {
          type: "START"
          id: string
          title: string
          repo: string
          environmentId: string
          environmentName: string
          environmentKind: Environment["kind"]
        }
      | { type: "PROGRESS"; phase: SessionCreationPhase }
      | { type: "FAILED"; error: unknown }
      | { type: "COMPLETED" }
      | { type: "DISMISS" }
  }
}).createMachine({
  id: "environment-session-startup",
  initial: "idle",
  context: { pending: null },
  states: {
    idle: {
      on: {
        START: {
          target: "running",
          actions: assign(({ event }) => ({
            pending: {
              id: event.id,
              title: event.title,
              repo: event.repo,
              environmentId: event.environmentId,
              environmentName: event.environmentName,
              environmentKind: event.environmentKind,
              phase: "checking-access" as const,
              error: null
            }
          }))
        }
      }
    },
    running: {
      on: {
        PROGRESS: {
          actions: assign(({ context, event }) => ({
            pending: context.pending === null
              ? null
              : { ...context.pending, phase: event.phase }
          }))
        },
        FAILED: {
          target: "failed",
          actions: assign(({ context, event }) => ({
            pending: context.pending === null
              ? null
              : { ...context.pending, error: messageOf(event.error) }
          }))
        },
        COMPLETED: {
          target: "idle",
          actions: assign({ pending: null })
        }
      }
    },
    failed: {
      on: {
        START: {
          target: "running",
          actions: assign(({ event }) => ({
            pending: {
              id: event.id,
              title: event.title,
              repo: event.repo,
              environmentId: event.environmentId,
              environmentName: event.environmentName,
              environmentKind: event.environmentKind,
              phase: "checking-access" as const,
              error: null
            }
          }))
        },
        DISMISS: {
          target: "idle",
          actions: assign({ pending: null })
        }
      }
    }
  }
})
