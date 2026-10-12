import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { IssueListItem } from "@jingler/core"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { filterIssues, IssueInbox } from "./issue-inbox.js"
import { initialIssueInboxFilters } from "./issue-inbox-filter-machine.js"

afterEach(cleanup)

const actor = (name: string) => ({ id: name, name, avatarUrl: null })
const item = (over: Partial<IssueListItem> = {}): IssueListItem => ({
  providerId: "github", id: "1", number: 1, identifier: "#1", url: "", title: "Crash on start", body: "",
  labels: [], state: "open", author: actor("morgan"), assignees: [], updatedAt: "2026-08-01T10:00:00.000Z",
  repository: "acme/widget", comments: 0, ...over,
})

describe("filterIssues", () => {
  const rows = [
    item(),
    item({ id: "2", number: 2, title: "Add docs", assignees: [actor("morgan")], author: actor("lee"), labels: [{ name: "Bug", color: null }] }),
    item({ id: "3", number: 3, repository: "acme/api", author: actor("sam") }),
  ]
  const numbers = (list: ReadonlyArray<IssueListItem>) => list.map((issue) => issue.number)

  it("filters by viewer relationship and search", () => {
    expect(numbers(filterIssues(rows, "created", "", "MORGAN"))).toEqual([1])
    expect(numbers(filterIssues(rows, "assigned", "", "morgan"))).toEqual([2])
    expect(numbers(filterIssues(rows, "all", "docs", "morgan"))).toEqual([2])
  })

  it("filters by repository, author, assignee and label facets case-insensitively", () => {
    expect(numbers(filterIssues(rows, "all", "", "morgan", { ...initialIssueInboxFilters, repository: "ACME/API" }))).toEqual([3])
    expect(numbers(filterIssues(rows, "all", "", "morgan", { ...initialIssueInboxFilters, author: "LEE", assignee: "Morgan", label: "bug" }))).toEqual([2])
    expect(filterIssues(rows, "all", "", "morgan", { ...initialIssueInboxFilters, label: "missing" })).toEqual([])
  })
})

describe("IssueInbox load states", () => {
  const props = { viewerLogin: "morgan", selected: null, detail: null, onSelect: () => {} }
  const mount = (ui: React.ReactElement) => render(<WidthTierValue width={1200}>{ui}</WidthTierValue>)

  it("shows a skeleton while loading and an empty state when nothing matches", () => {
    const { container, rerender } = mount(<IssueInbox {...props} issues={[]} loading />)
    expect(container.querySelector("[aria-busy='true']")).toBeTruthy()
    rerender(<WidthTierValue width={1200}><IssueInbox {...props} issues={[]} /></WidthTierValue>)
    expect(screen.getByText("No issues match this view.")).toBeTruthy()
  })

  it("shows the load error with Retry, and Retry recovers the list", () => {
    const onRetry = vi.fn()
    function Harness() {
      const [failed, setFailed] = useState(true)
      return <IssueInbox {...props} issues={failed ? [] : [item()]} error={failed ? "gh is not authenticated" : null}
        onRetry={() => { onRetry(); setFailed(false) }} />
    }
    mount(<Harness />)
    expect(screen.getByRole("alert").textContent).toContain("gh is not authenticated")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByRole("button", { name: /Crash on start/ })).toBeTruthy()
  })

  it("filters by relationship with the cataloged chips", () => {
    mount(<IssueInbox {...props} issues={[item(), item({ id: "2", number: 2, title: "Other", author: actor("lee") })]} />)
    fireEvent.click(screen.getByRole("radio", { name: "Created" }))
    expect(screen.queryByRole("button", { name: /Other/ })).toBeNull()
    expect(screen.getByRole("button", { name: /Crash on start/ })).toBeTruthy()
  })
})
