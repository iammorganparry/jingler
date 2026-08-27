import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PullRequest, PullRequestListItem } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { filterPullRequests, PullRequestInbox } from "./pull-request-inbox.js"

const item = (over: Partial<PullRequestListItem> = {}): PullRequestListItem => ({
  repository: "acme/widget",
  number: 42,
  title: "Fix token refresh",
  headRefName: "fix/token",
  baseRefName: "main",
  author: { login: "morgan", avatarUrl: null },
  state: "open",
  isDraft: false,
  additions: 12,
  deletions: 4,
  updatedAt: "2026-08-01T10:00:00.000Z",
  labels: [],
  comments: 2,
  assignedToViewer: false,
  reviewRequestedFromViewer: false,
  ...over
})

const detail: PullRequest = {
  ...item(),
  body: "Refresh expired tokens before retrying the request.",
  url: "https://github.com/acme/widget/pull/42",
  createdAt: "2026-08-01T09:00:00.000Z",
  commits: 2,
  changedFiles: 1,
  reviewers: [],
  timeline: [],
  reviewThreads: [],
  checks: [],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  mergeBlockers: []
}

const UPDATE_API = /Update API/
const FIX_TOKEN_REFRESH = /Fix token refresh/

const prs = [
  item(),
  item({ repository: "acme/api", number: 7, title: "Update API", author: { login: "lee", avatarUrl: null }, assignedToViewer: true }),
  item({ repository: "acme/web", number: 9, title: "Review login", author: { login: "sam", avatarUrl: null }, reviewRequestedFromViewer: true })
]

afterEach(cleanup)

describe("PullRequestInbox", () => {
  it("filters by viewer relationship and search", () => {
    expect(filterPullRequests(prs, "created", "", "morgan").map((pr) => pr.number)).toEqual([42])
    expect(filterPullRequests(prs, "assigned", "", "morgan").map((pr) => pr.number)).toEqual([7])
    expect(filterPullRequests(prs, "review-requested", "", "morgan").map((pr) => pr.number)).toEqual([9])
    expect(filterPullRequests(prs, "all", "api", "morgan").map((pr) => pr.number)).toEqual([7])
  })

  it("selects a pull request from the list", () => {
    const onSelect = vi.fn()
    render(
      <WidthTierValue width={1200}>
        <PullRequestInbox prs={prs} viewerLogin="morgan" selected={null} detail={null} onSelect={onSelect} />
      </WidthTierValue>
    )

    fireEvent.click(screen.getByRole("button", { name: UPDATE_API }))
    expect(onSelect).toHaveBeenCalledWith(prs[1])
  })

  it("shows detail request failures instead of a false empty PR state", () => {
    render(
      <WidthTierValue width={1200}>
        <PullRequestInbox prs={prs} viewerLogin="morgan" selected={{ repository: "acme/widget", number: 42 }} detail={null} detailError="GitHub could not load this pull request." onSelect={() => {}} />
      </WidthTierValue>
    )
    expect(screen.getByText("GitHub could not load this pull request.")).toBeTruthy()
    expect(screen.queryByText("No pull request yet for this branch")).toBeNull()
  })

  it("replaces the list with detail on small screens and returns", () => {
    render(
      <WidthTierValue width={480}>
        <PullRequestInbox prs={prs} viewerLogin="morgan" selected={{ repository: "acme/widget", number: 42 }} detail={detail} onSelect={() => {}} />
      </WidthTierValue>
    )

    fireEvent.click(screen.getByRole("button", { name: FIX_TOKEN_REFRESH }))
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy()
    expect(screen.queryByPlaceholderText("Search pull requests")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByPlaceholderText("Search pull requests")).toBeTruthy()
  })
})
