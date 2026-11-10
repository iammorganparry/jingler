import { assign, setup } from "xstate"

export interface TerminalSearchResults { readonly resultIndex: number; readonly resultCount: number }
const emptyResults: TerminalSearchResults = { resultIndex: -1, resultCount: 0 }
export const TERMINAL_SEARCH_HIGHLIGHT_LIMIT = 1_000

/** UI state only; the host supplies the terminal's synchronous search actions. */
export const terminalSearchMachine = setup({
  // SAFETY: XState reads these assertions as type metadata; createMachine initializes the runtime context below.
  types: {
    context: {} as TerminalSearchResults & { query: string; focusRevision: number },
    events: {} as
      | { type: "OPEN"; query?: string }
      | { type: "CHANGE"; query: string }
      | ({ type: "RESULTS" } & TerminalSearchResults)
      | { type: "NEXT" | "PREVIOUS" | "CLOSE" | "HIDE" | "RESET" | "REFRESH" }
  },
  actions: { search: () => {}, next: () => {}, previous: () => {}, clear: () => {}, focusTerminal: () => {} }
}).createMachine({
  id: "terminalSearch",
  initial: "closed",
  context: { query: "", focusRevision: 0, ...emptyResults },
  on: {
    OPEN: {
      target: ".open",
      actions: [assign(({ context, event }) => ({ query: event.query ?? context.query, focusRevision: context.focusRevision + 1, ...emptyResults })), "search"]
    },
    CLOSE: { target: ".closed", actions: ["clear", assign(emptyResults), "focusTerminal"] },
    HIDE: { target: ".closed", actions: ["clear", assign(emptyResults)] },
    RESET: { target: ".closed", actions: ["clear", assign({ query: "", ...emptyResults })] }
  },
  states: {
    closed: {},
    open: {
      on: {
        CHANGE: { actions: [assign(({ event }) => ({ query: event.query, ...emptyResults })), "search"] },
        RESULTS: { actions: assign(({ event }) => ({ resultIndex: event.resultIndex, resultCount: event.resultCount })) },
        NEXT: { actions: "next" },
        PREVIOUS: { actions: "previous" },
        REFRESH: { actions: "search" }
      }
    }
  }
})

export const terminalSearchCount = ({ resultCount, resultIndex }: TerminalSearchResults): string => {
  if (resultCount === 0) return "No matches"
  if (resultCount >= TERMINAL_SEARCH_HIGHLIGHT_LIMIT) return `${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+ matches`
  return resultIndex < 0 ? `${resultCount} matches` : `${resultIndex + 1} of ${resultCount}`
}
