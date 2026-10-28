import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import * as React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { ChatDrawer } from "./chat-drawer.js"

afterEach(cleanup)

function Harness() {
  const [open, setOpen] = React.useState(false)
  const [host, setHost] = React.useState<HTMLDivElement | null>(null)
  return (
    <>
      <div data-testid="sidebar" />
      <div ref={setHost} data-testid="content" className="relative">
        <button onClick={() => setOpen(true)}>Ask</button>
        {host && (
          <ChatDrawer open={open} onOpenChange={setOpen} container={host}>
            <p>transcript</p>
          </ChatDrawer>
        )}
      </div>
    </>
  )
}

describe("ChatDrawer", () => {
  it("mounts inside the content area (not over the sidebar), 400px wide, with a scrim", async () => {
    render(<Harness />)
    const opener = screen.getByRole("button", { name: "Ask" })
    opener.focus()
    fireEvent.click(opener)
    const drawer = await screen.findByTestId("chat-drawer")
    expect(screen.getByTestId("content").contains(drawer)).toBe(true)
    expect(screen.getByTestId("sidebar").contains(drawer)).toBe(false)
    expect(drawer.className).toContain("w-[400px]")
    expect(screen.getByTestId("chat-drawer-scrim")).toBeTruthy()
  })

  it("closes on Esc and returns focus to the opener", async () => {
    render(<Harness />)
    const opener = screen.getByRole("button", { name: "Ask" })
    opener.focus()
    fireEvent.click(opener)
    const drawer = await screen.findByTestId("chat-drawer")
    fireEvent.keyDown(drawer, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("chat-drawer")).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it("closes when the scrim is clicked", async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    await screen.findByTestId("chat-drawer")
    fireEvent.pointerDown(screen.getByTestId("chat-drawer-scrim"))
    fireEvent.click(screen.getByTestId("chat-drawer-scrim"))
    await waitFor(() => expect(screen.queryByTestId("chat-drawer")).toBeNull())
  })
})
