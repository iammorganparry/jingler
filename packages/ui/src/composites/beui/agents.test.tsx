import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { BEUI_AGENT_COMPONENTS, MessageScroller, ToolApproval } from "./index.js"

describe("BeUI agent catalog", () => {
  it("keeps all 17 official Agent entries unique", () => {
    expect(BEUI_AGENT_COMPONENTS).toHaveLength(17)
    expect(new Set(BEUI_AGENT_COMPONENTS)).toHaveLength(17)
  })

  it("releases transcript following when the reader leaves the live edge", () => {
    const onFollowChange = vi.fn()
    render(<MessageScroller onFollowChange={onFollowChange}><div>Message</div></MessageScroller>)
    const viewport = screen.getByRole("region", { name: "Conversation" })
    Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 }, scrollTop: { configurable: true, writable: true, value: 100 } })
    fireEvent.scroll(viewport)
    expect(onFollowChange).toHaveBeenCalledWith(false)
    viewport.scrollTop = 800
    fireEvent.scroll(viewport)
    expect(onFollowChange).toHaveBeenLastCalledWith(true)
  })

  it("builds the official clickable rail from Message rows", async () => {
    const view = render(<MessageScroller followOutput={false} smooth={false} navigation="rail" viewportRef={node => {
      if (node) Object.defineProperties(node, { scrollHeight: { configurable: true, value: 600 }, clientHeight: { configurable: true, value: 200 }, scrollTop: { configurable: true, writable: true, value: 0 } })
    }}><div data-slot="message" data-from="user">First message</div><div data-slot="message" data-from="assistant">Second message</div></MessageScroller>)
    const firstPoint = await view.findByRole("button", { name: "Go to user message 1 of 2" })
    const scrollTo = vi.fn()
    const viewport = view.container.querySelector("section") as HTMLElement & { scrollTo: typeof scrollTo }
    viewport.scrollTo = scrollTo
    fireEvent.click(firstPoint)
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }))
    expect(view.getByRole("navigation", { name: "Message navigation" })).toBeTruthy()
  })

  it("lets virtualized transcripts control every rail destination", () => {
    const onNavigationSelect = vi.fn()
    render(<MessageScroller navigation="rail" navigationItems={[
      { id: "first", label: "First" },
      { id: "last", label: "Last" }
    ]} navigationActiveId="first" onNavigationSelect={onNavigationSelect}><div /></MessageScroller>)
    fireEvent.click(screen.getByRole("button", { name: "Last" }))
    expect(onNavigationSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "last" }))
  })

  it("reports explicit tool permission decisions", () => {
    const onDecision = vi.fn()
    render(<ToolApproval title="Run command" status="pending" onDecision={onDecision} />)
    fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    expect(onDecision).toHaveBeenCalledWith("deny")
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(onDecision).toHaveBeenCalledWith("allow")
  })
})
