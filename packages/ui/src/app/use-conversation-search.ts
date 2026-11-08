import { normalizeConversationQuery } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { useEffect } from "react"
import { conversationSearchMachine, type ConversationSearchLoader } from "./conversation-search-machine.js"
import type { PaletteScope } from "./command-palette-model.js"

/** Ignore both late replies and the previous loader's results when the active chat changes. */
export function useConversationSearch(open: boolean, query: string, scope: PaletteScope, load: ConversationSearchLoader | undefined) {
  const [state, send] = useMachine(conversationSearchMachine)
  const text = normalizeConversationQuery(query)
  const enabled = load !== undefined && (scope === "workspace" || scope === "chat") && text.length >= 3 && text.length <= 160
  useEffect(() => {
    if (open && enabled && (scope === "workspace" || scope === "chat")) send({ type: "QUERY", query: text, scope, load })
    else send({ type: "RESET" })
  }, [open, enabled, text, scope, load, send])
  const current = enabled && state.context.query === text && state.context.scope === scope && state.context.load === load
  return {
    enabled,
    searching: enabled && (!current || state.matches("waiting") || state.matches("searching")),
    failed: current && state.context.failed,
    hits: current ? state.context.page.hits : [],
    hasMore: current && state.context.page.hasMore
  }
}
