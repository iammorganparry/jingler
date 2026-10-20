import { assign, fromPromise, setup } from "xstate"
import type { McpImportCandidateView } from "./mcp-config.js"

/**
 * MCP import-review lifecycle: detect candidates, let the operator confirm,
 * import them. Both network calls (detect, apply) can fail independently and
 * each needs its own Retry, so this is five coupled states rather than two
 * booleans — a statechart keeps "failed mid-import" from being confused with
 * "failed to even list candidates".
 */

export interface McpImportMachineInput {
  readonly detect: () => Promise<ReadonlyArray<McpImportCandidateView>>
  readonly apply: (candidates: ReadonlyArray<McpImportCandidateView>) => Promise<void>
}

interface Context {
  readonly detect: McpImportMachineInput["detect"]
  readonly apply: McpImportMachineInput["apply"]
  readonly candidates: ReadonlyArray<McpImportCandidateView>
  readonly error: string | null
}

type Event = { type: "START" } | { type: "RETRY" } | { type: "IMPORT" } | { type: "DISMISS" }

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

export const mcpImportMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as McpImportMachineInput
  },
  actors: {
    detect: fromPromise<ReadonlyArray<McpImportCandidateView>, { detect: Context["detect"] }>(
      ({ input }) => input.detect()
    ),
    apply: fromPromise<
      void,
      { apply: Context["apply"]; candidates: ReadonlyArray<McpImportCandidateView> }
    >(({ input }) => input.apply(input.candidates))
  }
}).createMachine({
  id: "mcpImport",
  context: ({ input }) => ({ detect: input.detect, apply: input.apply, candidates: [], error: null }),
  initial: "idle",
  states: {
    idle: {
      on: { START: "detecting" }
    },
    detecting: {
      invoke: {
        src: "detect",
        input: ({ context }) => ({ detect: context.detect }),
        onDone: [
          {
            guard: ({ event }) => event.output.length === 0,
            target: "empty",
            actions: assign({ candidates: ({ event }) => event.output, error: () => null })
          },
          {
            target: "reviewing",
            actions: assign({ candidates: ({ event }) => event.output, error: () => null })
          }
        ],
        onError: {
          target: "detectFailed",
          actions: assign({ error: ({ event }) => errorMessage(event.error, "Could not detect MCP servers") })
        }
      }
    },
    detectFailed: {
      on: { RETRY: "detecting" }
    },
    empty: { type: "final" },
    reviewing: {
      on: {
        IMPORT: "importing",
        DISMISS: "dismissed"
      }
    },
    importing: {
      invoke: {
        src: "apply",
        input: ({ context }) => ({ apply: context.apply, candidates: context.candidates }),
        onDone: { target: "done" },
        onError: {
          target: "importFailed",
          actions: assign({ error: ({ event }) => errorMessage(event.error, "Could not import MCP servers") })
        }
      }
    },
    importFailed: {
      on: { RETRY: "importing" }
    },
    done: { type: "final" },
    dismissed: { type: "final" }
  }
})
