import { conversationSearchText, type ConversationSearchHit, type Message } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export type ConversationSearchTarget = ConversationSearchHit & { readonly nonce: number; readonly query: string }
export interface ConversationSearchPreviewPage { readonly messages: ReadonlyArray<Message>; readonly focusIndex: number }
interface ConversationSearchPreviewContext {
  readonly target: ConversationSearchTarget | null
  readonly page: ConversationSearchPreviewPage | null
}
const SNIPPET_ELLIPSIS = /^…|…$/gu

/** Positions distinguish legacy duplicate ids. This projection never mutates the live transcript. */
export function conversationSearchPreviewPage(messages: ReadonlyArray<Message>, target: ConversationSearchTarget): ConversationSearchPreviewPage | null {
  const matched = messages[target.messageIndex]
  if (!matched || matched.id !== target.messageId || !conversationSearchText(matched).includes(target.snippet.replace(SNIPPET_ELLIPSIS, ""))) return null
  const visible: Message[] = []
  let focusIndex = -1
  for (const [index, message] of messages.entries()) {
    const parts = message.parts.filter((part) => part._tag === "Text")
    if (parts.length === 0) continue
    if (index === target.messageIndex) focusIndex = visible.length
    visible.push({ ...message, streaming: false, parts })
  }
  return focusIndex < 0 ? null : { messages: visible, focusIndex }
}

/** A bounded, read-only history window; the live conversation actor stays untouched. */
export const conversationSearchPreviewMachine = setup({
  // SAFETY: XState reads these assertions as type metadata; createMachine initializes the runtime context below.
  types: {
    context: {} as ConversationSearchPreviewContext,
    events: {} as { type: "OPEN"; target: ConversationSearchTarget } | { type: "CLOSE" }
  },
  actors: { load: fromPromise<ConversationSearchPreviewPage | null, ConversationSearchTarget>(async () => {
    throw new Error("Provide the saved conversation page loader")
  }) }
}).createMachine({
  id: "conversationSearchPreview",
  initial: "closed",
  context: { target: null, page: null },
  on: {
    OPEN: { target: ".loading", reenter: true, actions: assign(({ event }) => ({ target: event.target, page: null })) },
    CLOSE: { target: ".closed", actions: assign({ target: null, page: null }) }
  },
  states: {
    closed: {},
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => context.target!,
        onDone: [
          { guard: ({ event }) => event.output !== null, target: "ready", actions: assign({ page: ({ event }) => event.output }) },
          { target: "missing" }
        ],
        onError: "failed"
      }
    },
    ready: {},
    missing: {},
    failed: {}
  }
})
