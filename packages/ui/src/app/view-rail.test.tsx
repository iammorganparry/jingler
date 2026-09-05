/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { FolderTree, MessagesSquare } from "lucide-react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LinearMark } from "../components/linear-mark.js"
import { ViewRail } from "./view-rail.js"
import type { TabDescriptor } from "./tab-contributions.js"

afterEach(cleanup)

const SECOND_ISSUE = /ENG-2 Second issue/
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

  it("selects from a tab menu before opening its view", () => {
    const onChange = vi.fn()
    const onSelect = vi.fn()
    render(
      <ViewRail
        tabs={[...tabs, { id: "linear.issue", label: "Linear", icon: LinearMark }]}
        active="conversation"
        onChange={onChange}
        menus={{
          "linear.issue": {
            value: "issue-1",
            ariaLabel: "Select linked Linear issue",
            onSelect,
            options: [
              { value: "issue-1", label: "ENG-1", description: "First issue", ariaLabel: "ENG-1 First issue" },
              { value: "issue-2", label: "ENG-2", description: "Second issue", ariaLabel: "ENG-2 Second issue" }
            ]
          }
        }}
      />
    )

    const trigger = screen.getByRole("button", { name: "Select linked Linear issue" })
    expect(trigger.querySelector('[data-linear-mark="true"]')).not.toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("option", { name: SECOND_ISSUE }))
    expect(onSelect).toHaveBeenCalledWith("issue-2")
    expect(onChange).toHaveBeenCalledWith("linear.issue")
  })

  it("renders no terminal control without a toggle handler", () => {
    render(<ViewRail tabs={tabs} active="conversation" onChange={vi.fn()} />)
    expect(screen.queryByTestId("view-rail-terminal")).toBeNull()
  })
})
