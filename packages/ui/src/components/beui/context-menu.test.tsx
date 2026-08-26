import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "./context-menu.js"

afterEach(cleanup)

const renderMenu = (onRename = vi.fn()) => render(
  <ContextMenu>
    <ContextMenuTrigger><button type="button">Session</button></ContextMenuTrigger>
    <ContextMenuContent ariaLabel="Session actions">
      <ContextMenuItem textValue="Rename" onSelect={onRename}>Rename</ContextMenuItem>
      <ContextMenuItem textValue="Delete" tone="destructive">Delete</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
)

describe("BeUI ContextMenu", () => {
  it("opens at the pointer and closes after selection", async () => {
    const onRename = vi.fn()
    renderMenu(onRename)
    fireEvent.contextMenu(screen.getByRole("button", { name: "Session" }), { clientX: 120, clientY: 80 })

    const menu = await screen.findByRole("menu", { name: "Session actions" })
    await waitFor(() => expect(menu.dataset.morphReady).toBe("true"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("menu", { name: "Session actions", hidden: true }).parentElement?.getAttribute("aria-hidden")).toBe("true")
  })

  it("opens from Shift+F10 and supports keyboard movement", async () => {
    renderMenu()
    const trigger = screen.getByRole("button", { name: "Session" })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true })

    const menu = await screen.findByRole("menu", { name: "Session actions" })
    expect(menu.getAttribute("aria-hidden")).toBeNull()
    fireEvent.keyDown(menu, { key: "End" })
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }))
  })
})
