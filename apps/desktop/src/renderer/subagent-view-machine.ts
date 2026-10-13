/** Per-chat-lane swap between the main transcript and one subagent's transcript, in place. */
import { assign, setup } from "xstate"

export interface SubagentViewContext {
  readonly chatId: string
  readonly selectedId: string | null
  readonly mainDraft: string
  readonly mainScrollTop: number
}

export type SubagentViewEvent =
  | { readonly type: "OPEN_SUBAGENT"; readonly id: string }
  | { readonly type: "SWITCH_SIBLING"; readonly id: string }
  | { readonly type: "BACK" }
  | { readonly type: "SAVE_MAIN_VIEW"; readonly draft: string; readonly scrollTop: number }

export const subagentViewMachine = setup({
  types: {
    context: {} as SubagentViewContext,
    events: {} as SubagentViewEvent,
    input: {} as { readonly chatId: string }
  },
  guards: {
    isNewSubagent: ({ context, event }) =>
      (event.type === "OPEN_SUBAGENT" || event.type === "SWITCH_SIBLING") &&
      event.id !== context.selectedId
  },
  actions: {
    select: assign(({ event }) =>
      event.type === "OPEN_SUBAGENT" || event.type === "SWITCH_SIBLING"
        ? { selectedId: event.id }
        : {}
    ),
    clearSelection: assign({ selectedId: null }),
    saveMainView: assign(({ event }) =>
      event.type === "SAVE_MAIN_VIEW"
        ? { mainDraft: event.draft, mainScrollTop: event.scrollTop }
        : {}
    )
  }
}).createMachine({
  id: "subagentView",
  initial: "main",
  context: ({ input }) => ({
    chatId: input.chatId,
    selectedId: null,
    mainDraft: "",
    mainScrollTop: 0
  }),
  states: {
    main: {
      on: {
        SAVE_MAIN_VIEW: { actions: "saveMainView" },
        OPEN_SUBAGENT: { target: "subagent", actions: "select" }
      }
    },
    subagent: {
      on: {
        OPEN_SUBAGENT: { guard: "isNewSubagent", actions: "select" },
        SWITCH_SIBLING: { guard: "isNewSubagent", actions: "select" },
        BACK: { target: "main", actions: "clearSelection" }
      }
    }
  }
})
