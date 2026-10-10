import type { IssueListItem } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { filterIssues } from "./issue-inbox.js"
import { initialIssueInboxFilters } from "./issue-inbox-filter-machine.js"

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
