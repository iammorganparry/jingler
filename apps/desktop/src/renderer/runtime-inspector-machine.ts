import type { RuntimeDiagnosticSnapshot } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export interface RuntimeInspectorApi {
  readonly latest: () => Promise<RuntimeDiagnosticSnapshot | null>
  readonly export: (runId: string) => Promise<string>
}

export interface RuntimeInspectorContext {
  readonly runId: string
  readonly snapshot: RuntimeDiagnosticSnapshot | null
  readonly exported: string | null
  readonly error: string | null
}

type RuntimeInspectorEvent =
  | { readonly type: "LOAD" }
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
      load: fromPromise(() => api.latest()),
      export: fromPromise(({ input }: { input: RuntimeInspectorContext }) => api.export(input.runId))
    },
    guards: {
      hasRun: ({ context }) => context.runId.length > 0
    }
  }).createMachine({
    id: "runtime-inspector",
    initial: "loading",
    context: { runId: "", snapshot: null, exported: null, error: null },
    states: {
      idle: {
        on: {
          LOAD: {
            target: "loading",
            actions: assign({ error: null })
          }
        }
      },
      loading: {
        invoke: {
          src: "load",
          input: ({ context }) => context,
          onDone: {
            target: "ready",
            actions: assign({
              runId: ({ event }) => event.output?.runId ?? "",
              snapshot: ({ event }) => event.output,
              exported: null,
              error: null
            })
          },
          onError: { target: "failed", actions: assign({ error: ({ event }) => messageOf(event.error) }) }
        }
      },
      ready: {
        on: {
          LOAD: { target: "loading" },
          REFRESH: { target: "loading" },
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
          LOAD: { target: "loading" },
          REFRESH: { target: "loading" },
          CLEAR: { target: "idle", actions: assign({ runId: "", snapshot: null, exported: null, error: null }) }
        }
      }
    }
  })
