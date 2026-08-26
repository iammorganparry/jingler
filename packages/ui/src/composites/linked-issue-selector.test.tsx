import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  LinkedIssueSelector,
  type LinkedIssueSelectorItem
} from "./linked-issue-selector.js"

afterEach(cleanup)

const issues: ReadonlyArray<LinkedIssueSelectorItem> = [
  { value: "eng-124", identifier: "ENG-124", title: "Document retry policy" },
  { value: "eng-125", identifier: "ENG-125", title: "Reconcile duplicate charges" },
  { value: "eng-126", identifier: "ENG-126", title: "Add settlement audit events" }
]

describe("LinkedIssueSelector", () => {
  it("renders nothing when the session has no linked issues", () => {
    const { container } = render(<LinkedIssueSelector items={[]} value="missing" />)
    expect(container.innerHTML).toBe("")
  })

  it("renders one issue as a non-interactive labelled control", () => {
    render(<LinkedIssueSelector items={[issues[0]!]} value="eng-124" />)

    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByLabelText("Linked issue ENG-124: Document retry policy")).toBeDefined()
  })

  it("names the trigger with the selected issue and lists every option", () => {
    render(<LinkedIssueSelector items={issues} value="eng-125" />)

    const trigger = screen.getByRole("button", {
      name: "Select linked issue, current ENG-125: Reconcile duplicate charges"
    })
    expect(trigger.textContent).toContain("ENG-125")
    expect(trigger.textContent).toContain("Reconcile duplicate charges")

    fireEvent.click(trigger)
    expect(screen.getAllByRole("option")).toHaveLength(3)
    expect(screen.getByRole("option", { name: /ENG-124 Document retry policy/ })).toBeDefined()
  })

  it("emits the opaque value and closes after selection", async () => {
    const onValueChange = vi.fn()
    render(
      <LinkedIssueSelector
        items={issues}
        value="eng-124"
        onValueChange={onValueChange}
      />
    )

    fireEvent.click(screen.getByRole("button"))
    fireEvent.click(screen.getByRole("option", { name: /ENG-126 Add settlement audit events/ }))

    expect(onValueChange).toHaveBeenCalledWith("eng-126")
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull())
  })

  it("keeps compact triggers identifier-only while full triggers expose the title", () => {
    const { rerender } = render(
      <LinkedIssueSelector items={issues} value="eng-124" variant="compact" />
    )
    const trigger = screen.getByRole("button")
    expect(trigger.textContent).toContain("ENG-124")
    expect(trigger.textContent).not.toContain("Document retry policy")

    rerender(<LinkedIssueSelector items={issues} value="eng-124" variant="full" />)
    expect(screen.getByRole("button").textContent).toContain("Document retry policy")
  })

  it("preserves the full title as a tooltip when visible text truncates", () => {
    const title = "A very long issue title that cannot fit inside a narrow split pane"
    render(
      <LinkedIssueSelector
        items={[
          { value: "long", identifier: "PLATFORM-982", title },
          issues[0]!
        ]}
        value="long"
      />
    )

    expect(screen.getByTitle(title)).toBeDefined()
  })

  it("adds search when many issues are linked", () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      value: `issue-${index}`,
      identifier: `ENG-${index}`,
      title: `Issue ${index}`
    }))
    render(<LinkedIssueSelector items={many} value="issue-0" />)

    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByPlaceholderText("Search linked issues…")).toBeDefined()
  })
})
