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
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }))
    expect(onFollowChange).toHaveBeenLastCalledWith(true)
    viewport.scrollTop = 800
    fireEvent.scroll(viewport)
    expect(onFollowChange).toHaveBeenLastCalledWith(true)
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
