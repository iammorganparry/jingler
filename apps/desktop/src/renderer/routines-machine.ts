import type { RoutineDocument, RoutineInput } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"
export interface RoutinesApi {
  open(id: string): Promise<void>
  list(): Promise<RoutineDocument>
  save(id: string | undefined, input: RoutineInput): Promise<RoutineDocument>
  enable(id: string, enabled: boolean): Promise<RoutineDocument>
  delete(id: string): Promise<RoutineDocument>
  runNow(id: string): Promise<unknown>
  cancel(id: string): Promise<RoutineDocument>
}
type Command = { type: "SAVE"; id?: string; input: RoutineInput } | { type: "ENABLE"; id: string; enabled: boolean } | { type: "DELETE" | "RUN" | "CANCEL" | "OPEN"; id: string } | { type: "REFRESH" }
export const routinesMachine = setup({
  types: { context: {} as { api: RoutinesApi; document: RoutineDocument; command: Command; error: string | null; editing: string | undefined }, input: {} as { api: RoutinesApi }, events: {} as Command | { type: "EDIT"; id?: string } },
  actors: { operation: fromPromise(async ({ input }: { input: { api: RoutinesApi; command: Command } }) => {
    const { api, command } = input
    if (command.type === "SAVE") return api.save(command.id, command.input)
    if (command.type === "ENABLE") return api.enable(command.id, command.enabled)
    if (command.type === "DELETE") return api.delete(command.id)
    if (command.type === "CANCEL") return api.cancel(command.id)
    if (command.type === "OPEN") await api.open(command.id)
    if (command.type === "RUN") await api.runNow(command.id)
    return api.list()
  }) }
}).createMachine({
  id: "routines", initial: "working",
  context: ({ input }) => ({ ...input, document: { version: 1, routines: [], runs: [] }, command: { type: "REFRESH" }, error: null, editing: undefined }),
  states: {
    ready: { after: { 2000: { target: "working", actions: assign({ command: { type: "REFRESH" } }) } }, on: {
      EDIT: { actions: assign({ editing: ({ event }) => event.id }) },
      SAVE: { target: "working", actions: assign({ command: ({ event }) => event }) },
      ENABLE: { target: "working", actions: assign({ command: ({ event }) => event }) },
      DELETE: { target: "working", actions: assign({ command: ({ event }) => event }) },
      OPEN: { target: "working", actions: assign({ command: ({ event }) => event }) },
      RUN: { target: "working", actions: assign({ command: ({ event }) => event }) },
      CANCEL: { target: "working", actions: assign({ command: ({ event }) => event }) },
      REFRESH: { target: "working", actions: assign({ command: ({ event }) => event }) }
    } },
    working: { entry: assign({ error: null }), invoke: { src: "operation", input: ({ context }) => context, onDone: { target: "ready", actions: assign({ document: ({ event }) => event.output, editing: ({ context, event }) => context.command.type === "SAVE" ? context.command.id ?? event.output.routines.at(-1)?.id : context.command.type === "DELETE" && context.command.id === context.editing ? undefined : context.editing }) }, onError: { target: "failed", actions: assign({ error: ({ event }) => event.error instanceof Error ? event.error.message : String(event.error) }) } } },
    failed: { on: { REFRESH: { target: "working", actions: assign({ command: { type: "REFRESH" } }) } } }
  }
})
