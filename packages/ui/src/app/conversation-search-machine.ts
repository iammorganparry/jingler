import type { ConversationSearchPage } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export interface ConversationSearchRequest { readonly query: string; readonly scope: "workspace" | "chat" }
export type ConversationSearchLoader = (query: string, scope: "workspace" | "chat", signal: AbortSignal) => Promise<ConversationSearchPage>

const emptyPage: ConversationSearchPage = { hits: [], hasMore: false }

/** A new query or a closed palette cancels the previous request and its debounce. */
export const conversationSearchMachine = setup({
  // SAFETY: XState reads these assertions as type metadata; createMachine initializes the runtime context below.
  types: {
    context: {} as ConversationSearchRequest & { load: ConversationSearchLoader | null; page: ConversationSearchPage; failed: boolean },
    events: {} as ({ type: "QUERY"; load: ConversationSearchLoader } & ConversationSearchRequest) | { type: "RESET" }
  },
  actors: {
    search: fromPromise<ConversationSearchPage, ConversationSearchRequest & { load: ConversationSearchLoader }>(({ input, signal }) => input.load(input.query, input.scope, signal))
  }
}).createMachine({
  id: "conversationSearch",
  initial: "idle",
  context: { query: "", scope: "workspace", load: null, page: emptyPage, failed: false },
  on: {
    QUERY: {
      target: ".waiting",
      reenter: true,
      actions: assign(({ event }) => ({ query: event.query, scope: event.scope, load: event.load, page: emptyPage, failed: false }))
    },
    RESET: {
      target: ".idle",
      actions: assign({ query: "", load: null, page: emptyPage, failed: false })
    }
  },
  states: {
    idle: {},
    waiting: { after: { 180: "searching" } },
    searching: {
      invoke: {
        src: "search",
        input: ({ context }) => ({ query: context.query, scope: context.scope, load: context.load! }),
        onDone: { target: "ready", actions: assign({ page: ({ event }) => event.output }) },
        onError: { target: "ready", actions: assign({ failed: true }) }
      }
    },
    ready: {}
  }
})
