import { useState } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BEUI_AGENT_COMPONENTS, MessageScroller, ToolApproval } from "./index.js"

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

const scrollMetrics = (viewport: HTMLElement, top: number) => Object.defineProperties(viewport, {
  scrollHeight: { configurable: true, value: 1000 },
  clientHeight: { configurable: true, value: 200 },
  scrollTop: { configurable: true, writable: true, value: top }
})

describe("BeUI agent catalog", () => {
  it.each(["wheel", "touch", "keyboard"])("protects initial positioning until the reader uses %s", (input) => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] })
    const onFollowChange = vi.fn()
    render(<MessageScroller onFollowChange={onFollowChange}><div>Message</div></MessageScroller>)
    const viewport = screen.getByRole("region", { name: "Conversation" })
    scrollMetrics(viewport, 700)
    fireEvent.scroll(viewport)
    expect(onFollowChange).not.toHaveBeenCalled()
    if (input === "wheel") fireEvent.wheel(viewport, { deltaY: -100 })
    else if (input === "touch") fireEvent.touchStart(viewport)
    else fireEvent.keyDown(viewport, { key: "PageUp" })
    viewport.scrollTop = 600
    fireEvent.scroll(viewport)
    expect(onFollowChange).toHaveBeenCalledWith(false)
  })

  it("releases initial scroll protection when already at the end", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] })
    const onFollowChange = vi.fn()
    render(<MessageScroller onFollowChange={onFollowChange}><div>Message</div></MessageScroller>)
    const viewport = screen.getByRole("region", { name: "Conversation" })
    scrollMetrics(viewport, 800)
    act(() => vi.advanceTimersByTime(20))
    viewport.scrollTop = 600
    fireEvent.scroll(viewport)
    expect(onFollowChange).toHaveBeenCalledWith(false)
  })
  it("keeps an in-flight catch-up protected through a resize at the live edge", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] })
    const resizes: Array<() => void> = []
    vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resizes.push(() => callback([], this)) }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    const onFollowChange = vi.fn()
    render(<MessageScroller onFollowChange={onFollowChange}><div>Message</div></MessageScroller>)
    const viewport = screen.getByRole("region", { name: "Conversation" })
    scrollMetrics(viewport, 700)
    let top = 700
    Object.defineProperty(viewport, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = Math.min(800, value) } })
    act(() => vi.advanceTimersByTime(20))
    expect(viewport.scrollTop).toBe(800)
    act(() => { for (const resize of resizes) resize() })
    viewport.scrollTop = 600
    fireEvent.scroll(viewport)
    expect(onFollowChange).not.toHaveBeenCalled()
    fireEvent.wheel(viewport, { deltaY: -100 })
    viewport.scrollTop = 500
    fireEvent.scroll(viewport)
    expect(onFollowChange).toHaveBeenCalledWith(false)
  })

  it("keeps all 17 official Agent entries unique", () => {
    expect(BEUI_AGENT_COMPONENTS).toHaveLength(17)
    expect(new Set(BEUI_AGENT_COMPONENTS)).toHaveLength(17)
  })

  it("releases transcript following when the reader leaves the live edge", () => {
    const onFollowChange = vi.fn()
    render(<MessageScroller onFollowChange={onFollowChange}><div>Message</div></MessageScroller>)
    const viewport = screen.getByRole("region", { name: "Conversation" })
    scrollMetrics(viewport, 100)
    fireEvent.wheel(viewport, { deltaY: -100 })
    fireEvent.scroll(viewport)
    expect(onFollowChange).toHaveBeenCalledWith(false)
    viewport.scrollTop = 800
    fireEvent.scroll(viewport)
    expect(onFollowChange).toHaveBeenLastCalledWith(true)
  })

  it("keeps controlled follow mode off during smooth navigation to an earlier rail item", async () => {
    const changes = vi.fn()
    const Controlled = () => {
      const [following, setFollowing] = useState(true)
      return <MessageScroller followOutput={following} onFollowChange={(value) => { changes(value); setFollowing(value) }} navigation="rail" viewportRef={(node) => { if (node) scrollMetrics(node, 800) }}>
        <div data-slot="message" data-from="user">Earlier</div>
        <div data-slot="message" data-from="assistant">Latest</div>
      </MessageScroller>
    }
    render(<Controlled />)
    const first = await screen.findByRole("button", { name: "Go to user message 1 of 2" })
    const viewport = screen.getByRole("region", { name: "Conversation" })
    scrollMetrics(viewport, 800)
    const scrollTo = vi.fn()
    viewport.scrollTo = scrollTo
    fireEvent.click(first)
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }))
    viewport.scrollTop = 780
    fireEvent.scroll(viewport)
    expect(changes.mock.calls).toEqual([[false]])
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
