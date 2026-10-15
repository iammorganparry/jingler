import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Composer } from "./composer.js"
import { CommandMenu } from "./command-menu.js"
import { MentionMenu } from "./mention-menu.js"

const skills = [
  { name: "/deploy", description: "Ship it", source: "skill" as const },
  { name: "/review", description: "Review the diff", source: "command" as const }
]

afterEach(cleanup)

describe("autocomplete menus", () => {
  it("groups slash rows, highlights the match and shows the keyboard footer", () => {
    const { container } = render(<CommandMenu skills={skills} activeIndex={0} query="rev" onSelect={() => {}} />)
    expect(screen.getByText("Commands")).toBeTruthy()
    expect(screen.getByText("Skills")).toBeTruthy()
    expect(container.querySelector("mark")?.textContent).toBe("rev")
    expect(screen.getByText("navigate")).toBeTruthy()
    expect(screen.getByText("select")).toBeTruthy()
    expect(screen.getByText("close")).toBeTruthy()
  })

  it("shows No matches with the typed query, and nothing for an empty query", () => {
    const { container, rerender } = render(<MentionMenu files={[]} activeIndex={0} query="zzz" onSelect={() => {}} />)
    expect(screen.getByRole("status").textContent).toBe("No matches for “zzz”")
    rerender(<MentionMenu files={[]} activeIndex={0} query="" onSelect={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it("opens the right menu for each trigger and reports no matches in the composer", () => {
    render(<Composer skills={skills} files={["src/a.ts"]} />)
    const box = screen.getByRole("textbox")
    fireEvent.change(box, { target: { value: "/" } })
    expect(screen.getByText("Commands")).toBeTruthy()
    fireEvent.change(box, { target: { value: "@" } })
    expect(screen.getByRole("listbox", { name: "Files" })).toBeTruthy()
    fireEvent.change(box, { target: { value: "@nothing" } })
    expect(screen.getByRole("status").textContent).toBe("No matches for “nothing”")
  })
})
