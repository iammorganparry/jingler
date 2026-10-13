import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PublishCheckpoint, PullRequest, SessionPr } from "@jingler/core"
import { userEvent } from "@testing-library/user-event"
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

describe("PullRequestView publish stepper", () => {
  it("shows 3-step stepper during publishing", () => {
    const checkpoint: PublishCheckpoint = {
      step: "committing",
      completed: ["verifying-branch", "generating-metadata", "staging"],
      updatedAt: "2026-08-26T08:00:00Z"
    }
    render(
      <WidthTierValue width={1200}>
        <PullRequestView pr={null} connected publish={checkpoint} publishing onCreatePr={() => {}} />
      </WidthTierValue>
    )
    expect(screen.getByText("Commit")).toBeTruthy()
    expect(screen.getByText("Push")).toBeTruthy()
    expect(screen.getByText("Open PR")).toBeTruthy()
  })

  it("marks the failing step on push failure", () => {
    const checkpoint: PublishCheckpoint = {
      step: "failed",
      completed: ["verifying-branch", "generating-metadata", "staging", "committing", "authenticating"],
      resumeFrom: "pushing",
      error: "Network timeout during push",
      updatedAt: "2026-08-26T08:00:00Z"
    }
    const onRetry = vi.fn()
    render(
      <WidthTierValue width={1200}>
        <PullRequestView pr={null} connected publish={checkpoint} onCreatePr={() => {}} onRetryPublish={onRetry} />
      </WidthTierValue>
    )
    expect(screen.getByText("Publishing stopped")).toBeTruthy()
    expect(screen.getByText("Network timeout during push")).toBeTruthy()
    const retryButton = screen.getByRole("button", { name: /Retry from Push/i })
    expect(retryButton).toBeTruthy()
    fireEvent.click(retryButton)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("shows completed checkmarks for finished phases", () => {
    const checkpoint: PublishCheckpoint = {
      step: "creating-pr",
      completed: ["verifying-branch", "generating-metadata", "staging", "committing", "authenticating", "pushing"],
      updatedAt: "2026-08-26T08:00:00Z"
    }
    render(
      <WidthTierValue width={1200}>
        <PullRequestView pr={null} connected publish={checkpoint} publishing onCreatePr={() => {}} />
      </WidthTierValue>
    )
    // Commit and Push phases should be marked done
    expect(screen.getAllByRole("listitem").length).toBe(3)
  })

  it("shows nothing-to-publish state", () => {
    const checkpoint: PublishCheckpoint = {
      step: "no-changes",
      completed: [],
      updatedAt: "2026-08-26T08:00:00Z"
    }
    render(
      <WidthTierValue width={1200}>
        <PullRequestView pr={null} connected publish={checkpoint} onCreatePr={() => {}} />
      </WidthTierValue>
    )
    expect(screen.getByText("Nothing to publish")).toBeTruthy()
  })
})

const basePrs: ReadonlyArray<SessionPr> = [
  { number: 100, branch: "feat/layer-1", base: "main", state: "open", checks: null },
  { number: 101, branch: "feat/layer-2", base: "feat/layer-1", state: "open", checks: null }
]

describe("PullRequestView base selector", () => {
  it("defaults to top of stack when stack is non-empty", () => {
    const onCreatePr = vi.fn()
    render(
      <PullRequestView
        pr={null}
        connected={true}
        baseBranch="main"
        prs={basePrs}
        onCreatePr={onCreatePr}
      />
    )

    expect(screen.getByText("feat/layer-2")).toBeTruthy()
  })

  it("defaults to baseBranch when stack is empty", () => {
    const onCreatePr = vi.fn()
    render(
      <PullRequestView
        pr={null}
        connected={true}
        baseBranch="main"
        prs={[]}
        onCreatePr={onCreatePr}
      />
    )

    expect(screen.getByLabelText("Select base branch for pull request").textContent).toContain("main")
  })

  it("passes selected base to onCreatePr when publish button clicked", async () => {
    const user = userEvent.setup()
    const onCreatePr = vi.fn()
    
    render(
      <PullRequestView
        pr={null}
        connected={true}
        baseBranch="main"
        branch="feat/layer-3"
        prs={basePrs}
        onCreatePr={onCreatePr}
      />
    )

    const publishButton = screen.getByRole("button", { name: /publish pull request/i })
    await user.click(publishButton)

    expect(onCreatePr).toHaveBeenCalledWith("feat/layer-2")
  })

  it("allows choosing a different base and passes it to onCreatePr", async () => {
    const user = userEvent.setup()
    const onCreatePr = vi.fn()
    
    render(
      <PullRequestView
        pr={null}
        connected={true}
        baseBranch="main"
        branch="feat/layer-3"
        prs={basePrs}
        onCreatePr={onCreatePr}
      />
    )

    // Open the selector
    const trigger = screen.getByLabelText("Select base branch for pull request")
    await user.click(trigger)

    // Select the base branch option
    const mainOption = await screen.findByRole("option", { name: "main" })
    await user.click(mainOption)

    // Click publish
    const publishButton = screen.getByRole("button", { name: /publish pull request/i })
    await user.click(publishButton)

    expect(onCreatePr).toHaveBeenCalledWith("main")
  })
})
