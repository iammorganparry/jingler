import type { ProjectRoutineTemplate, RoutineDocument, RoutineInput } from "@jingler/core"
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
type Command =
  | { type: "SAVE"; id?: string; input: RoutineInput }
  | { type: "ENABLE"; id: string; enabled: boolean }
  | { type: "DELETE" | "RUN" | "CANCEL" | "OPEN"; id: string }
  | { type: "REFRESH" }
interface RoutinesContext {
  api: RoutinesApi
  document: RoutineDocument
  command: Command
  loaded: boolean
  error: string | null
  template: ProjectRoutineTemplate | undefined
  templateProjectId: string | undefined
  templateLoad: number
  editing: string | undefined
  feedback: { projectId: string; message: string } | null
}
type RoutinesEvent = Command | { type: "TEMPLATE"; projectId: string; template: ProjectRoutineTemplate } | { type: "EDIT"; id?: string }
const operation = fromPromise(async ({ input }: { input: { api: RoutinesApi; command: Command } }) => {
  const { api, command } = input
  if (command.type === "SAVE") return api.save(command.id, command.input)
  if (command.type === "ENABLE") return api.enable(command.id, command.enabled)
  if (command.type === "DELETE") return api.delete(command.id)
  if (command.type === "CANCEL") return api.cancel(command.id)
  if (command.type === "OPEN") await api.open(command.id)
  if (command.type === "RUN") await api.runNow(command.id)
  return api.list()
})
export const routinesMachine = setup<
  RoutinesContext,
  RoutinesEvent,
  { operation: typeof operation },
  {},
  {},
  {},
  never,
  string,
  { api: RoutinesApi }
>({
  actors: { operation },
}).createMachine({
  id: "routines",
  initial: "working",
  context: ({ input }) => ({
    ...input,
    document: { version: 1, routines: [], runs: [] },
    command: { type: "REFRESH" },
    loaded: false,
    error: null,
    template: undefined,
    templateProjectId: undefined,
    templateLoad: 0,
    editing: undefined,
    feedback: null,
  }),
  states: {
    ready: {
      initial: "idle",
      states: {
        idle: {
          after: { 2000: { target: "refreshing", actions: assign({ command: { type: "REFRESH" } }) } },
        },
        refreshing: {
          // Exiting ready for a user command stops this actor. A late read
          // cannot overwrite the mutation result; EDIT keeps the read alive.
          invoke: {
            src: "operation",
            input: ({ context }) => ({ api: context.api, command: { type: "REFRESH" } }),
            onDone: {
              target: "idle",
              actions: assign({ document: ({ event }) => event.output, error: null }),
            },
            onError: {
              target: "idle",
              actions: assign({
                error: ({ event }) => (event.error instanceof Error ? event.error.message : String(event.error)),
              }),
            },
          },
          on: { REFRESH: {} },
        },
      },
      on: {
        TEMPLATE: { actions: assign({ editing: undefined, templateProjectId: ({ event }) => event.projectId, template: ({ event }) => event.template, templateLoad: ({ context }) => context.templateLoad + 1, feedback: null }) },
        EDIT: { actions: assign({ template: undefined, editing: ({ event }) => event.id, feedback: null }) },
        SAVE: { target: "#routines.working", actions: assign({ command: ({ event }) => event }) },
        ENABLE: { target: "#routines.working", actions: assign({ command: ({ event }) => event }) },
        DELETE: { target: "#routines.working", actions: assign({ command: ({ event }) => event }) },
        OPEN: { target: "#routines.working", actions: assign({ command: ({ event }) => event }) },
        RUN: { target: "#routines.working", actions: assign({ command: ({ event }) => event }) },
        CANCEL: { target: "#routines.working", actions: assign({ command: ({ event }) => event }) },
        REFRESH: { target: ".refreshing", actions: assign({ command: ({ event }) => event }) },
      },
    },
    working: {
      entry: assign({
        error: null,
        feedback: ({ context }) => (context.command.type === "REFRESH" ? context.feedback : null),
      }),
      invoke: {
        src: "operation",
        input: ({ context }) => context,
        onDone: {
          target: "ready",
          actions: assign({
            template: ({ context }) => context.command.type === "SAVE" ? undefined : context.template,
            loaded: true,
            document: ({ event }) => event.output,
            feedback: ({ context }) =>
              context.command.type === "SAVE"
                ? {
                    projectId: context.command.input.projectId,
                    message: "Routine saved and approved for these exact settings.",
                  }
                : context.feedback,
            editing: ({ context, event }) =>
              context.command.type === "SAVE"
                ? (context.command.id ?? event.output.routines.at(-1)?.id)
                : context.command.type === "DELETE" && context.command.id === context.editing
                  ? undefined
                  : context.editing,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : String(event.error)),
          }),
        },
      },
    },
    failed: { on: { REFRESH: { target: "working", actions: assign({ command: { type: "REFRESH" } }) } } },
  },
})
