import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { testSession as session } from "../test-support.js"
import { ArchivedEntry, ArchivedList, searchArchived } from "./archived-list.js"

afterEach(cleanup)

const SESSIONS = [
  session({ id: "a", title: "Old auth work", archived: true, archivedAt: "2026-07-01T00:00:00.000Z" }),
  session({ id: "b", title: "Fresh billing fix", archived: true, archivedAt: "2026-07-09T00:00:00.000Z" }),
  session({ id: "c", title: "Still active" })
]

describe("searchArchived", () => {
  it("lists only archived sessions, most recently archived first, narrowed by the query", () => {
    expect(searchArchived(SESSIONS, "").map((s) => s.id)).toEqual(["b", "a"])
    expect(searchArchived(SESSIONS, "auth").map((s) => s.id)).toEqual(["a"])
  })
})

describe("ArchivedList", () => {
  it("searches and wires Restore and Delete per row", () => {
    const onRestore = vi.fn()
    const onDelete = vi.fn()
    render(<ArchivedList open onOpenChange={() => {}} sessions={SESSIONS} onRestore={onRestore} onDelete={onDelete} />)
    expect(screen.getByText("Archived (2)")).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox", { name: "Search archived…" }), { target: { value: "billing" } })
    expect(screen.queryByTestId("archived-row-a")).toBeNull()
    const row = within(screen.getByTestId("archived-row-b"))
    fireEvent.click(row.getByRole("button", { name: "Restore Fresh billing fix" }))
    expect(onRestore).toHaveBeenCalledWith("b")
    fireEvent.click(row.getByRole("button", { name: "Delete Fresh billing fix" }))
    expect(onDelete).toHaveBeenCalledWith("b")
  })

  it("says so when nothing matches", () => {
    render(<ArchivedList open onOpenChange={() => {}} sessions={SESSIONS} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Search archived…" }), { target: { value: "zzz" } })
    expect(screen.getByText("No archived workspaces match.")).toBeTruthy()
  })
})

describe("ArchivedEntry", () => {
  it("shows the archived count and opens the list; hidden when nothing is archived", () => {
    const { rerender } = render(<ArchivedEntry sessions={SESSIONS} />)
    const entry = screen.getByTestId("archived-sidebar-item")
    expect(entry.textContent).toContain("Archived")
    expect(entry.textContent).toContain("2")
    fireEvent.click(entry)
    expect(screen.getByRole("dialog")).toBeTruthy()
    rerender(<ArchivedEntry sessions={[SESSIONS[2]!]} />)
    expect(screen.queryByTestId("archived-sidebar-item")).toBeNull()
  })
})
