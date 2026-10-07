import { assign, fromPromise, setup } from "xstate"
import type { VaultChoice } from "./discovery.js"
import type { Note } from "./vault.js"

export interface NotesServices {
  discover?(): Promise<VaultChoice[]>
  configuration(): Promise<string>
  configure(root: string): Promise<string>
  list(): Promise<string[]>
  read(path: string): Promise<Note>
}
interface Context {
  services: NotesServices
  root: string
  configuredRoot: string
  vaults: VaultChoice[]
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
    configuration: fromPromise(async ({ input }: { input: NotesServices }) => {
      const vaults = await input.discover?.().catch(() => []) ?? []
      try { return { vaults, root: await input.configuration(), error: "" } }
      catch (cause) { return { vaults, root: "", error: cause instanceof Error ? cause.message : String(cause) } }
    }),
    configure: fromPromise(({ input }: { input: Context }) => input.services.configure(input.root)),
    read: fromPromise(({ input }: { input: Context }) => input.services.read(input.selected)),
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
  context: ({ input }) => ({ services: input.services, root: "", configuredRoot: "", vaults: [], paths: [], selected: "", note: null, error: "" }),
  states: {
    configuration: {
      invoke: {
        src: "configuration", input: ({ context }) => context.services,
        onDone: [
          { guard: ({ event }) => !!event.output.root, target: "loading", actions: assign(({ event }) => ({ ...event.output, configuredRoot: event.output.root })) },
          { target: "ready", actions: assign(({ event }) => event.output) }
        ],
        onError: { target: "ready", actions: "fail" }
      }
    },
    ready: {
      on: {
        ROOT: { actions: assign({ root: ({ event }) => event.value }) },
        SAVE: { target: "saving", actions: "clear" },
        REFRESH: { guard: ({ context }) => !!context.configuredRoot, target: "loading", actions: "clear" },
        SELECT: { target: "reading", actions: ["clear", assign({ selected: ({ event }) => event.path })] }
      }
    },
    saving: {
      invoke: {
        src: "configure", input: ({ context }) => context,
        onDone: { target: "loading", actions: assign({ root: ({ event }) => event.output, configuredRoot: ({ event }) => event.output, selected: "", paths: [] }) },
        onError: { target: "ready", actions: "fail" }
      }
    },
    reading: {
      invoke: {
        src: "read", input: ({ context }) => context,
        onDone: { target: "ready", actions: assign({ note: ({ event }) => event.output }) },
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
