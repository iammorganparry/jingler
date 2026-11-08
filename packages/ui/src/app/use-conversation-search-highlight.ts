import { type RefObject, useLayoutEffect } from "react"
import { conversationSearchRange } from "./conversation-search-highlight.js"

export const CONVERSATION_SEARCH_HIGHLIGHT = "jingler-conversation-search"

/** Paint only the matched phrase; rich text and the user's own selection stay intact. */
export function useConversationSearchHighlight(rootRef: RefObject<HTMLElement | null>, query: string | undefined) {
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !query || !globalThis.CSS?.highlights || !("Highlight" in globalThis)) return
    const registry = CSS.highlights
    let highlight: Highlight | null = null
    let ownedRange: Range | null = null
    const clear = () => {
      if (ownedRange) highlight?.delete(ownedRange)
      ownedRange = null
      if (highlight?.size === 0 && registry.get(CONVERSATION_SEARCH_HIGHLIGHT) === highlight) registry.delete(CONVERSATION_SEARCH_HIGHLIGHT)
      highlight = null
    }
    const update = () => {
      clear()
      const message = root.querySelector<HTMLElement>('[data-search-match="true"]')
      ownedRange = message ? conversationSearchRange(message, query) : null
      if (!ownedRange) return
      highlight = registry.get(CONVERSATION_SEARCH_HIGHLIGHT) ?? new Highlight()
      highlight.add(ownedRange)
      registry.set(CONVERSATION_SEARCH_HIGHLIGHT, highlight)
    }
    update()
    // Virtualization and asynchronous code rendering may replace the text nodes.
    const observer = new MutationObserver(update)
    observer.observe(root, { childList: true, characterData: true, subtree: true })
    return () => { observer.disconnect(); clear() }
  }, [rootRef, query])
}
