/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { FolderTree, MessagesSquare } from "lucide-react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ViewRail } from "./view-rail.js"
import type { TabDescriptor } from "./tab-contributions.js"

afterEach(cleanup)

const tabs: ReadonlyArray<TabDescriptor> = [
  { id: "conversation", label: "Conversation", icon: MessagesSquare },
  {
    id: "files",
    label: "Changes",
    icon: FolderTree,
    badge: { kind: "diff", added: 3, removed: 1 }
  }
]

describe("ViewRail", () => {
  it("switches views from the vertical rail", () => {
    const onChange = vi.fn()
    render(
      <ViewRail tabs={tabs} active="conversation" onChange={onChange} />
    )
    expect(
      screen.getByRole("button", { name: "Conversation" }).getAttribute("aria-current")
    ).toBe("page")
    fireEvent.click(screen.getByRole("button", { name: "Changes" }))
    expect(onChange).toHaveBeenCalledWith("files")
  })

  it("binds the session terminal toggle to the rail", () => {
    const onToggleTerminal = vi.fn()
    render(
      <ViewRail
        tabs={tabs}
        active="conversation"
        onChange={vi.fn()}
        terminalActive={false}
        onToggleTerminal={onToggleTerminal}
      />
    )
    const toggle = screen.getByRole("button", { name: "Show Terminal" })
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(toggle)
    expect(onToggleTerminal).toHaveBeenCalledOnce()
  })

  it("renders no terminal control without a toggle handler", () => {
    render(<ViewRail tabs={tabs} active="conversation" onChange={vi.fn()} />)
    expect(screen.queryByTestId("view-rail-terminal")).toBeNull()
  })
})
