import type { RuntimeDiagnosticSnapshot } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export interface RuntimeInspectorApi {
  readonly get: (runId: string) => Promise<RuntimeDiagnosticSnapshot | null>
  readonly export: (runId: string) => Promise<string>
}

interface RuntimeInspectorContext {
  readonly runId: string
  readonly snapshot: RuntimeDiagnosticSnapshot | null
  readonly exported: string | null
  readonly error: string | null
}

type RuntimeInspectorEvent =
  | { readonly type: "LOAD"; readonly runId: string }
  | { readonly type: "REFRESH" }
  | { readonly type: "EXPORT" }
  | { readonly type: "CLEAR" }

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "Runtime diagnostics are unavailable."

export const createRuntimeInspectorMachine = (api: RuntimeInspectorApi) =>
  setup({
    types: {
      context: {} as RuntimeInspectorContext,
      events: {} as RuntimeInspectorEvent
    },
    actors: {
      load: fromPromise(({ input }: { input: RuntimeInspectorContext }) => api.get(input.runId)),
      export: fromPromise(({ input }: { input: RuntimeInspectorContext }) => api.export(input.runId))
    },
    guards: {
      hasRun: ({ context }) => context.runId.length > 0
    }
  }).createMachine({
    id: "runtime-inspector",
    initial: "idle",
    context: { runId: "", snapshot: null, exported: null, error: null },
    states: {
      idle: {
        on: {
          LOAD: {
            target: "loading",
            actions: assign({ runId: ({ event }) => event.runId, error: null })
          }
        }
      },
      loading: {
        invoke: {
          src: "load",
          input: ({ context }) => context,
          onDone: { target: "ready", actions: assign({ snapshot: ({ event }) => event.output, error: null }) },
          onError: { target: "failed", actions: assign({ error: ({ event }) => messageOf(event.error) }) }
        }
      },
      ready: {
        on: {
          REFRESH: { target: "loading", guard: "hasRun" },
          EXPORT: { target: "exporting", guard: "hasRun" },
          CLEAR: { target: "idle", actions: assign({ runId: "", snapshot: null, exported: null, error: null }) }
        }
      },
      exporting: {
        invoke: {
          src: "export",
          input: ({ context }) => context,
          onDone: { target: "ready", actions: assign({ exported: ({ event }) => event.output, error: null }) },
          onError: { target: "failed", actions: assign({ error: ({ event }) => messageOf(event.error) }) }
        }
      },
      failed: {
        on: {
          REFRESH: { target: "loading", guard: "hasRun" },
          CLEAR: { target: "idle", actions: assign({ runId: "", snapshot: null, exported: null, error: null }) }
        }
      }
    }
  })
