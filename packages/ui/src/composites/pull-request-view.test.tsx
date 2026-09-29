import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PullRequest } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { PullRequestView } from "./pull-request-view.js"

const pr: PullRequest = {
  number: 1838,
  state: "open",
  title: "Surface the actual API error",
  body: "A focused error-handling fix.",
  url: "https://github.com/acme/widget/pull/1838",
  headRefName: "fix/error",
  baseRefName: "main",
  isDraft: false,
  author: { login: "morgan", avatarUrl: null },
  createdAt: "2026-08-26T08:00:00Z",
  commits: 1,
  commitItems: [{ sha: "abcdef123", message: "fix error", author: "morgan", committedAt: "2026-08-26T08:00:00Z", url: "https://github.com/acme/widget/commit/abcdef123", verified: true }],
  changedFiles: 3,
  additions: 10,
  deletions: 2,
  labels: [],
  reviewers: [],
  timeline: [],
  reviewThreads: [],
  checks: [{ name: "Typecheck", status: "pass", detailsUrl: null, durationMs: 1200 }],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  mergeBlockers: []
}

afterEach(cleanup)

describe("PullRequestView evidence navigation", () => {
  it("switches between overview, commits, and checks", () => {
    render(<WidthTierValue width={1200}><PullRequestView pr={pr} connected /></WidthTierValue>)

    fireEvent.click(screen.getByRole("tab", { name: "Commits 1" }))
    expect(screen.getByText("fix error")).toBeTruthy()
    expect(screen.getByText("abcdef1")).toBeTruthy()

    fireEvent.click(screen.getByRole("tab", { name: "Checks 1" }))
    expect(screen.getAllByText("Typecheck").length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("tab", { name: "Overview" }))
    expect(screen.getByText("A focused error-handling fix.")).toBeTruthy()
  })

  it("routes Files changed through the supplied callback", () => {
    const onOpenFiles = vi.fn()
    render(<WidthTierValue width={1200}><PullRequestView pr={pr} connected onOpenFiles={onOpenFiles} /></WidthTierValue>)
    fireEvent.click(screen.getByRole("tab", { name: "Files changed 3" }))
    expect(onOpenFiles).toHaveBeenCalledTimes(1)
  })

  it("floats the details rail when the PR pane is medium width", () => {
    render(<WidthTierValue width={700}><PullRequestView pr={pr} connected readOnly /></WidthTierValue>)
    expect(screen.getByRole("button", { name: "Pull request details" })).toBeTruthy()
  })

  it("closes the compact details sheet by button or Escape", () => {
    render(<WidthTierValue width={480}><PullRequestView pr={pr} connected readOnly /></WidthTierValue>)
    fireEvent.click(screen.getByRole("button", { name: "Pull request details" }))
    const close = screen.getByRole("button", { name: "Close pull request details" })
    expect(close).toBeTruthy()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.getByRole("button", { name: "Pull request details" })).toBeTruthy()
  })

  it("moves merge-method radios with arrow keys", () => {
    render(<WidthTierValue width={1200}><PullRequestView pr={pr} connected onMerge={() => {}} /></WidthTierValue>)
    const merge = screen.getByRole("radio", { name: "Merge" })
    const squash = screen.getByRole("radio", { name: "Squash" })
    merge.focus()
    fireEvent.keyDown(merge, { key: "ArrowRight" })
    expect(squash.getAttribute("aria-checked")).toBe("true")
    expect(document.activeElement).toBe(squash)
  })

  it("hides write controls in read-only views", () => {
    render(<WidthTierValue width={1200}><PullRequestView pr={pr} connected readOnly /></WidthTierValue>)
    expect(screen.queryByText("Add a review")).toBeNull()
    expect(screen.queryByRole("button", { name: "Merge pull request" })).toBeNull()
  })
})
