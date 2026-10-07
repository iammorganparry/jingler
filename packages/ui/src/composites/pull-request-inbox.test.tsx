import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { PullRequest, PullRequestListItem } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { filterPullRequests, PullRequestInbox } from "./pull-request-inbox.js"
import { initialInboxFilters } from "./pull-request-inbox-filter-machine.js"

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
  it("combines case-insensitive repository, author and label with draft, text and personal relationship filters", () => {
    const rows = [
      item({ labels: [{ name: "Bug", color: "ff0000" }] }),
      item({ number: 43, isDraft: true, author: { login: "Lee", avatarUrl: null }, assignedToViewer: true, labels: [{ name: "Bug", color: "ff0000" }] }),
      item({ repository: "acme/api", number: 7, author: { login: "Lee", avatarUrl: null }, isDraft: true }),
    ]
    const facets = { ...initialInboxFilters, repository: "ACME/WIDGET", author: "LEE", label: "BUG", draft: "draft" as const }
    expect(filterPullRequests(rows, "assigned", "token", "morgan", facets).map((pr) => pr.number)).toEqual([43])
    expect(filterPullRequests(rows, "created", "", "morgan", facets)).toEqual([])
    expect(filterPullRequests(rows, "all", "", "morgan", { ...initialInboxFilters, draft: "ready" }).map((pr) => pr.number)).toEqual([42])
    expect(filterPullRequests(rows, "all", "", "morgan", { ...initialInboxFilters, label: "missing" })).toEqual([])
  })

  it("searches BeUI filter choices, retains unfiltered options and preserves the draft when filtering and clearing", async () => {
    const rows = [
      item({ labels: [{ name: "Bug", color: "ff0000" }] }),
      item({ number: 43, title: "Draft token fix", isDraft: true, author: { login: "lee", avatarUrl: null }, labels: [{ name: "Bug", color: "ff0000" }] }),
      item({ repository: "acme/api", number: 7, title: "Update API", author: { login: "sam", avatarUrl: null } }),
    ]
    render(<WidthTierValue width={1200}><PullRequestInbox prs={rows} viewerLogin="morgan"
      selected={rows[0]!} detail={detail} onSelect={() => {}} onComment={async () => {}}
    /></WidthTierValue>)
    const composer = screen.getByPlaceholderText("Leave a comment…")
    fireEvent.change(composer, { target: { value: "Keep this draft" } })
    fireEvent.click(screen.getByRole("button", { name: "Filter by repository" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Search repository options" }), { target: { value: "widget" } })
    expect(screen.queryByRole("option", { name: "acme/api" })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: "acme/widget" }))
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Filter by author" }))
    expect(screen.getByRole("option", { name: "sam" })).toBeTruthy()
    fireEvent.click(screen.getByRole("option", { name: "lee" }))
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Filter by label" }))
    fireEvent.click(screen.getByRole("option", { name: "Bug" }))
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Filter by draft status" }))
    fireEvent.click(screen.getByRole("option", { name: "Draft" }))
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    fireEvent.change(screen.getByPlaceholderText("Search pull requests"), { target: { value: "Draft token" } })
    expect(screen.getByText("1 of 3 loaded PRs")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Update API/ })).toBeNull()
    expect(composer).toHaveProperty("value", "Keep this draft")
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(screen.getByText("3 of 3 loaded PRs")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Update API/ })).toBeTruthy()
    expect(composer).toHaveProperty("value", "Keep this draft")
    expect(screen.getByPlaceholderText("Search pull requests")).toHaveProperty("value", "")
  })

  it("shows team queues independently of personal relationships and exposes partial results/refresh", () => {
    const onTeam = vi.fn()
    const onQueue = vi.fn()
    const onRefresh = vi.fn()
    const onActivate = vi.fn()
    render(<WidthTierValue width={1200}><PullRequestInbox
      prs={prs} viewerLogin="someone-else" selected={null} detail={null} onSelect={() => {}}
      onActivate={onActivate}
      teamControls={{
        teams: [{ id: "7", organization: "acme", slug: "platform", name: "Platform" }],
        teamId: "7", queue: "reviews", onTeam, onQueue, onRefresh, discovering: false, error: null,
      }}
      warnings={["GitHub search timed out."]}
    /></WidthTierValue>)
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: UPDATE_API })).toBeTruthy()
    expect(screen.getByText("Partial results")).toBeTruthy()
    fireEvent.change(screen.getByRole("combobox", { name: "Team pull request queue" }), { target: { value: "authored" } })
    expect(onQueue).toHaveBeenCalledWith("authored")
    fireEvent.change(screen.getByRole("combobox", { name: "Pull request scope" }), { target: { value: "" } })
    expect(onTeam).toHaveBeenCalledWith(null)
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

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

  it("invokes the selected pull request session action", () => {
    const onSelect = vi.fn()
    render(
      <WidthTierValue width={1200}>
        <PullRequestInbox
          prs={prs}
          viewerLogin="morgan"
          selected={{ repository: "acme/widget", number: 42 }}
          detail={detail}
          onSelect={() => {}}
          sessionAction={{ label: "Create session", onSelect }}
        />
      </WidthTierValue>
    )

    fireEvent.click(screen.getByRole("button", { name: "Create session" }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("routes files locally and submits global pull request actions", async () => {
    const onOpenFiles = vi.fn()
    const onComment = vi.fn(async () => undefined)
    const onClosePr = vi.fn(async () => undefined)
    const onMerge = vi.fn()
    render(
      <WidthTierValue width={1200}>
        <PullRequestInbox
          prs={prs}
          viewerLogin="morgan"
          selected={{ repository: "acme/widget", number: 42 }}
          detail={detail}
          onSelect={() => {}}
          onOpenFiles={onOpenFiles}
          onComment={onComment}
          onClosePr={onClosePr}
          onMerge={onMerge}
          sessionAction={{ label: "Create session", onSelect: () => {} }}
        />
      </WidthTierValue>
    )

    const sessionButton = screen.getByRole("button", { name: "Create session" })
    expect(sessionButton.getAttribute("data-slot")).toBe("button")
    expect(sessionButton.querySelector(".lucide-download")).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Files changed 1" }))
    expect(onOpenFiles).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByPlaceholderText("Leave a comment…"), {
      target: { value: "Ship it" }
    })
    fireEvent.click(screen.getByRole("button", { name: "Comment" }))
    await waitFor(() => expect(onComment).toHaveBeenCalledWith("Ship it"))

    const mergeButton = screen.getByRole("button", { name: "Merge pull request" })
    const closeButton = screen.getByRole("button", { name: "Close pull request" })
    expect(mergeButton.compareDocumentPosition(closeButton) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    fireEvent.click(closeButton)
    const closeButtons = screen.getAllByRole("button", { name: "Close pull request" })
    fireEvent.click(closeButtons.at(-1)!)
    await waitFor(() => expect(onClosePr).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }))
    expect(onMerge).toHaveBeenCalledWith("merge")
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
    const onCreateSession = vi.fn()
    render(
      <WidthTierValue width={480}>
        <PullRequestInbox
          prs={prs}
          viewerLogin="morgan"
          selected={{ repository: "acme/widget", number: 42 }}
          detail={detail}
          onSelect={() => {}}
          sessionAction={{ label: "Create session", onSelect: onCreateSession }}
        />
      </WidthTierValue>
    )

    fireEvent.click(screen.getByRole("button", { name: FIX_TOKEN_REFRESH }))
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Create session" }))
    expect(onCreateSession).toHaveBeenCalledTimes(1)
    expect(screen.queryByPlaceholderText("Search pull requests")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByPlaceholderText("Search pull requests")).toBeTruthy()
  })
})
