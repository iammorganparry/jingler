import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { testSession } from "../test-support.js"
import { PersistentSessionTile } from "./persistent-session-tile.js"

afterEach(cleanup)

describe("PersistentSessionTile", () => {
  it("identifies and selects the session with active and live-status state", () => {
    const onSelect = vi.fn()
    render(
      <PersistentSessionTile
        session={testSession({
          id: "kept",
          title: "Keep auth warm",
          persistent: true,
          status: "idle"
        })}
        activity={{ kind: "running", verb: "Running", target: "pnpm test" }}
        active
        onSelect={onSelect}
      />
    )

    const tile = screen.getByRole("button", { name: "Keep auth warm" })
    expect(tile.getAttribute("aria-current")).toBe("page")
    expect(tile.getAttribute("data-status")).toBe("running")
    expect(screen.getByText("Running")).toBeDefined()
    expect(tile.getAttribute("title")).toContain("Running pnpm test")

    tile.focus()
    expect(document.activeElement).toBe(tile)
    fireEvent.click(tile)
    expect(onSelect).toHaveBeenCalledWith("kept")
  })

  it("offers unpersist, archive, and confirmed-delete requests", () => {
    const onUnpersist = vi.fn()
    const onArchive = vi.fn()
    const onDelete = vi.fn()
    render(
      <PersistentSessionTile
        session={testSession({ id: "kept", title: "Keep auth warm", persistent: true })}
        onUnpersist={onUnpersist}
        onArchive={onArchive}
        onDelete={onDelete}
      />
    )

    const tile = screen.getByRole("button", { name: "Keep auth warm" })

    fireEvent.contextMenu(tile)
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpersist" }))
    expect(onUnpersist).toHaveBeenCalledWith("kept")

    fireEvent.contextMenu(tile)
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }))
    expect(onArchive).toHaveBeenCalledWith("kept")

    fireEvent.contextMenu(tile)
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))
    expect(onDelete).toHaveBeenCalledWith("kept")
  })
})
