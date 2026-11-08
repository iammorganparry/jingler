import { useRef } from "react"
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { conversationSearchRange } from "./conversation-search-highlight.js"
import { CONVERSATION_SEARCH_HIGHLIGHT, useConversationSearchHighlight } from "./use-conversation-search-highlight.js"

const root = (html: string) => {
  const element = document.createElement("div")
  element.innerHTML = html
  return element
}
const paragraphs = (...text: string[]) => text.map((value) => `<p>${value}</p>`).join("")

describe("conversation phrase ranges", () => {
  it.each([
    ['<p>The connection <strong>pool</strong> timeout is fixed.</p>', "connection pool timeout", "connection pool timeout"],
    ['<p>Connection<br>pool timeout</p>', "connection pool timeout", "Connectionpool timeout"],
    [paragraphs("cache[retry]", "timeout"), "cache[retry] timeout", "cache[retry]timeout"],
    ['<p>İstanbul uses cache[retry].</p>', "CACHE[RETRY]", "cache[retry]"],
    ['<p>Two\n\t spaced words.</p>', "two spaced", "Two\n\t spaced"]
  ])("preserves markup while highlighting %s", (html, query, found) => {
    const element = root(`<div class="sb-md">${html}</div>`)
    const before = element.innerHTML
    expect(conversationSearchRange(element, query)?.toString()).toBe(found)
    expect(element.innerHTML).toBe(before)
  })

  it("ignores author labels and action buttons and selects only the first prose match", () => {
    const element = root('<header>needle</header><div class="sb-md"><button>needle</button><p>First needle, then needle.</p></div>')
    const range = conversationSearchRange(element, "needle")
    expect(range?.startContainer.parentElement?.tagName).toBe("P")
    expect(range?.startOffset).toBe(6)
    expect(range?.toString()).toBe("needle")
    expect(conversationSearchRange(element, "missing")).toBeNull()
    expect(conversationSearchRange(element, "  ")).toBeNull()
  })
})

const QUERY = "connection pool timeout"
function Preview({ query = QUERY, shown = true }: { query?: string; shown?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useConversationSearchHighlight(ref, query)
  return <div ref={ref}>{shown && <div data-search-match="true"><div className="sb-md"><p>The connection <strong>pool</strong> timeout is fixed.</p></div></div>}</div>
}

let registry: Map<string, Set<Range>>
beforeEach(() => {
  registry = new Map()
  vi.stubGlobal("Highlight", class extends Set<Range> {})
  vi.stubGlobal("CSS", { ...globalThis.CSS, highlights: registry })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("native conversation highlights", () => {
  it("leaves user selection and markup intact, and removes its ranges on close", () => {
    const selected = document.createElement("p")
    selected.textContent = "User selection"
    document.body.append(selected)
    const selection = document.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(selected)
    selection.addRange(range)
    const view = render(<Preview />)
    expect([...registry.get(CONVERSATION_SEARCH_HIGHLIGHT)!].map((entry) => entry.toString())).toEqual([QUERY])
    expect(view.container.querySelector("strong")?.textContent).toBe("pool")
    expect(selection.toString()).toBe("User selection")
    view.unmount()
    expect(registry.size).toBe(0)
    selection.removeAllRanges()
    selected.remove()
  })

  it("keeps independent panes highlighted as virtualized messages disappear and return", async () => {
    const view = render(<><Preview /><Preview /></>)
    expect(registry.get(CONVERSATION_SEARCH_HIGHLIGHT)?.size).toBe(2)
    view.rerender(<><Preview shown={false} /><Preview /></>)
    await waitFor(() => expect(registry.get(CONVERSATION_SEARCH_HIGHLIGHT)?.size).toBe(1))
    view.rerender(<><Preview /><Preview /></>)
    await waitFor(() => expect(registry.get(CONVERSATION_SEARCH_HIGHLIGHT)?.size).toBe(2))
    view.unmount()
    expect(registry.size).toBe(0)
  })

  it("clears the old highlight when the query changes", () => {
    const view = render(<Preview />)
    view.rerender(<Preview query="missing" />)
    expect(registry.size).toBe(0)
  })
})
