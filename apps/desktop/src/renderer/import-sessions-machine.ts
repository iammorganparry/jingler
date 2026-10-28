import type { ImportableSession } from "@jingler/core"
import { importSessionKey } from "@jingler/ui"
import { assign, fromPromise, setup } from "xstate"

export interface ImportSessionsContext {
  candidates: ReadonlyArray<ImportableSession>
  selected: ReadonlySet<string>
  /** Keys still waiting for `importOne`; drained one at a time while importing. */
  queue: ReadonlyArray<string>
  query: string
  error: string | null
}

type ImportSessionsEvent =
  | { type: "TOGGLE"; key: string }
  | { type: "QUERY"; query: string }
  | { type: "IMPORT" }
  | { type: "RETRY" }
  | { type: "SKIP" }

const notProvided = (name: string) => async (): Promise<never> => {
  throw new Error(`importSessionsMachine: provide the "${name}" actor`)
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : "Could not import sessions.")

export const importSessionsMachine = setup({
  types: {
    context: {} as ImportSessionsContext,
    events: {} as ImportSessionsEvent
  },
  actors: {
    // Real implementations are supplied with `.provide` (rpc.sessionsScanImportable / rpc.sessionsImport).
    scan: fromPromise<ReadonlyArray<ImportableSession>>(notProvided("scan")),
    importOne: fromPromise<unknown, ImportableSession>(notProvided("importOne"))
  },
  actions: {
    toggle: assign(({ context, event }) => {
      if (event.type !== "TOGGLE") return {}
      const row = context.candidates.find((session) => importSessionKey(session) === event.key)
      if (!row || row.alreadyImported) return {}
      const selected = new Set(context.selected)
      if (!selected.delete(event.key)) selected.add(event.key)
      return { selected }
    })
  },
  guards: {
    hasQueued: ({ context }) => context.queue.length > 1
  }
}).createMachine({
  id: "importSessions",
  initial: "scanning",
  context: { candidates: [], selected: new Set(), queue: [], query: "", error: null },
  states: {
    scanning: {
      entry: assign({ error: null }),
      invoke: {
        src: "scan",
        onDone: {
          target: "ready",
          actions: assign({ candidates: ({ event }) => event.output, selected: () => new Set<string>() })
        },
        onError: { target: "failed", actions: assign({ error: ({ event }) => errorText(event.error) }) }
      }
    },
    ready: {
      on: {
        TOGGLE: { actions: "toggle" },
        QUERY: { actions: assign({ query: ({ event }) => event.query }) },
        IMPORT: { guard: ({ context }) => context.selected.size > 0, target: "importing" },
        SKIP: "done"
      }
    },
    importing: {
      entry: assign({ queue: ({ context }) => [...context.selected] }),
      initial: "one",
      states: {
        one: {
          invoke: {
            src: "importOne",
            input: ({ context }) => context.candidates.find((s) => importSessionKey(s) === context.queue[0])!,
            onDone: [
              { guard: "hasQueued", target: "one", reenter: true, actions: assign({ queue: ({ context }) => context.queue.slice(1) }) },
              { target: "#importSessions.done" }
            ],
            onError: {
              target: "#importSessions.failed",
              actions: assign({ error: ({ event }) => errorText(event.error) })
            }
          }
        }
      }
    },
    done: { type: "final" },
    failed: { on: { RETRY: "scanning", SKIP: "done" } }
  }
})
