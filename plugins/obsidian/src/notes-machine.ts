import { assign, fromPromise, setup } from "xstate"
import type { Note } from "./vault.js"

export interface NotesServices {
  configuration(): Promise<string>
  configure(root: string): Promise<string>
  list(): Promise<string[]>
  read(path: string): Promise<Note>
}
interface Context {
  services: NotesServices
  root: string
  paths: string[]
  selected: string
  note: Note | null
  error: string
}
type Event = { type: "ROOT"; value: string } | { type: "SAVE" } | { type: "REFRESH" } | { type: "SELECT"; path: string }
export const notesMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as { services: NotesServices }
  },
  actors: {
    configuration: fromPromise(({ input }: { input: NotesServices }) => input.configuration()),
    configure: fromPromise(({ input }: { input: Context }) => input.services.configure(input.root)),
    load: fromPromise(async ({ input }: { input: Context }) => {
      const paths = await input.services.list()
      const selected = paths.includes(input.selected) ? input.selected : paths[0] ?? ""
      try {
        const note = selected ? await input.services.read(selected) : null
        return { paths, selected, note, error: "" }
      } catch (cause) {
        return { paths, selected, note: null, error: cause instanceof Error ? cause.message : String(cause) }
      }
    })
  },
  actions: {
    clear: assign({ error: "", note: null }),
    fail: assign({ error: ({ event }) => "error" in event ? String(event.error instanceof Error ? event.error.message : event.error) : "Unable to load vault." })
  }
}).createMachine({
  id: "obsidian-notes",
  initial: "configuration",
  context: ({ input }) => ({ services: input.services, root: "", paths: [], selected: "", note: null, error: "" }),
  states: {
    configuration: {
      invoke: {
        src: "configuration", input: ({ context }) => context.services,
        onDone: [
          { guard: ({ event }) => !!event.output, target: "loading", actions: assign({ root: ({ event }) => event.output }) },
          { target: "ready" }
        ],
        onError: { target: "ready", actions: "fail" }
      }
    },
    ready: {
      on: {
        ROOT: { actions: assign({ root: ({ event }) => event.value }) },
        SAVE: { target: "saving", actions: "clear" },
        REFRESH: { target: "loading", actions: "clear" },
        SELECT: { target: "loading", actions: ["clear", assign({ selected: ({ event }) => event.path })] }
      }
    },
    saving: {
      invoke: {
        src: "configure", input: ({ context }) => context,
        onDone: { target: "loading", actions: assign({ root: ({ event }) => event.output, selected: "", paths: [] }) },
        onError: { target: "ready", actions: "fail" }
      }
    },
    loading: {
      invoke: {
        src: "load", input: ({ context }) => context,
        onDone: { target: "ready", actions: assign(({ event }) => event.output) },
        onError: { target: "ready", actions: ["fail", assign({ paths: [], note: null })] }
      }
    }
  }
})
