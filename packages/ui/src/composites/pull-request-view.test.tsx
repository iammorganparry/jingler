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

    fireEvent.click(screen.getByRole("tab", { name: "Checks 1/1" }))
    expect(screen.getAllByText("Typecheck").length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }))
    expect(screen.getByText("A focused error-handling fix.")).toBeTruthy()
  })

  it("routes Files changed through the supplied callback", () => {
    const onOpenFiles = vi.fn()
    render(<WidthTierValue width={1200}><PullRequestView pr={pr} connected onOpenFiles={onOpenFiles} /></WidthTierValue>)
    fireEvent.click(screen.getByRole("tab", { name: "Files 3" }))
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

describe("PullRequestView load states", () => {
  it("shows a skeleton while loading and a retryable error when the read fails", () => {
    const { unmount } = render(<PullRequestView pr={null} connected busy />)
    expect(screen.getByLabelText("Loading pull request")).toBeTruthy()
    expect(screen.queryByText("No pull request yet for this branch")).toBeNull()
    unmount()

    const onRetryLoad = vi.fn()
    render(<PullRequestView pr={null} connected loadError="GitHub is down" onRetryLoad={onRetryLoad} />)
    expect(screen.getByText("GitHub is down")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetryLoad).toHaveBeenCalledTimes(1)
  })

  it("shows an empty state for a PR with no checks or timeline", () => {
    render(<WidthTierValue width={1200}><PullRequestView pr={{ ...pr, checks: [] }} connected /></WidthTierValue>)
    expect(screen.getByText("No reviews or comments yet")).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Checks" }))
    expect(screen.getByText("CI results will appear here once a run starts.")).toBeTruthy()
  })
})

describe("PullRequestView not-connected, merged/closed and read-only states", () => {
  it("shows the connection message and Connect GitHub instead of a load error when disconnected", () => {
    const onConnectGithub = vi.fn()
    render(
      <PullRequestView pr={null} connected={false} loadError="boom" connectionMessage="Install the GitHub App on acme/widget." onConnectGithub={onConnectGithub} />
    )
    expect(screen.getByText("Install the GitHub App on acme/widget.")).toBeTruthy()
    expect(screen.queryByText("boom")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }))
    expect(onConnectGithub).toHaveBeenCalledTimes(1)
  })

  it("tints the Merged and Closed header badges", () => {
    render(<WidthTierValue width={1200}><PullRequestView pr={{ ...pr, state: "merged" }} connected /></WidthTierValue>)
    expect(screen.getByText("Merged").closest('[class*="text-purple"]')).toBeTruthy()
    cleanup()
    render(<WidthTierValue width={1200}><PullRequestView pr={{ ...pr, state: "closed" }} connected /></WidthTierValue>)
    expect(screen.getByText("Closed").closest('[class*="text-red"]')).toBeTruthy()
  })

  it("exposes no write action in a read-only view and keeps Start session", async () => {
    const onOpenSession = vi.fn()
    render(
      <WidthTierValue width={1200}>
        <PullRequestView pr={{ ...pr, state: "draft" }} connected readOnly onOpenSession={onOpenSession} sessionActionLabel="Start session from this PR" />
      </WidthTierValue>
    )
    fireEvent.click(screen.getByRole("button", { name: "Start session from this PR" }))
    expect(onOpenSession).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Add a review")).toBeNull()
    for (const name of ["Merge pull request", "Mark ready for review", "Close pull request", "Approve", "Request changes"])
      expect(screen.queryByRole("button", { name })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "More actions" }))
    expect(screen.queryByRole("menuitem", { name: "Mark ready" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Close PR" })).toBeNull()
  })
})

describe("PullRequestView header", () => {
  const renderPr = (value: PullRequest) =>
    render(<WidthTierValue width={600}><PullRequestView pr={value} connected /></WidthTierValue>)

  it("renders title, grey number, and every meta field on one line", () => {
    renderPr(pr)
    expect(screen.getByRole("heading", { name: /Surface the actual API error/ }).textContent).toContain("#1838")
    const meta = screen.getByTestId("pr-meta-line")
    expect(meta.textContent).toContain("Open")
    expect(meta.textContent).toContain("morgan")
    expect(meta.textContent).toContain("fix/error → main")
    expect(meta.textContent).toContain("1 commit")
    expect(meta.textContent).toContain("3 files")
    expect(meta.textContent).toContain("+10")
    expect(meta.className).toContain("whitespace-nowrap")
    expect(meta.className).not.toContain("flex-wrap")
  })

  it("labels draft and merged states", () => {
    renderPr({ ...pr, state: "draft" })
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain("Draft")
    expect(screen.getByTestId("pr-meta-line").textContent).not.toContain("Draft")
    cleanup()
    renderPr({ ...pr, state: "merged" })
    expect(screen.getByTestId("pr-meta-line").textContent).toContain("Merged")
  })

  it("omits missing fields instead of showing a dash", () => {
    renderPr({ ...pr, commits: 0, changedFiles: 0, additions: 0, deletions: 0, headRefName: "", createdAt: "not a date" })
    const text = screen.getByTestId("pr-meta-line").textContent ?? ""
    expect(text).not.toContain("—")
    expect(text).not.toContain("commit")
    expect(text).not.toContain("file")
    expect(text).not.toContain("→")
    expect(screen.queryByRole("button", { name: "Copy branch name" })).toBeNull()
  })

  it("copies the head branch", () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    renderPr(pr)
    fireEvent.click(screen.getByRole("button", { name: "Copy branch name" }))
    expect(writeText).toHaveBeenCalledWith("fix/error")
  })
})

describe("PullRequestView header actions", () => {
  const open = async (props: Partial<React.ComponentProps<typeof PullRequestView>>, value: PullRequest = pr) => {
    render(<WidthTierValue width={900}><PullRequestView pr={value} connected {...props} /></WidthTierValue>)
    await userEvent.click(screen.getByRole("button", { name: "More actions" }))
  }

  it("opens on GitHub and the session from their header buttons", () => {
    const onOpenOnGithub = vi.fn()
    const onOpenSession = vi.fn()
    render(<WidthTierValue width={900}><PullRequestView pr={pr} connected onOpenOnGithub={onOpenOnGithub} onOpenSession={onOpenSession} sessionActionLabel="Open session" /></WidthTierValue>)
    fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }))
    fireEvent.click(screen.getByRole("button", { name: "Open session" }))
    expect(onOpenOnGithub).toHaveBeenCalledTimes(1)
    expect(onOpenSession).toHaveBeenCalledTimes(1)
  })

  it("marks a draft ready from the menu", async () => {
    const onMarkReady = vi.fn()
    await open({ onMarkReady }, { ...pr, state: "draft" })
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark ready" }))
    expect(onMarkReady).toHaveBeenCalledTimes(1)
  })

  it("offers no Mark ready on a non-draft PR", async () => {
    await open({ onMarkReady: vi.fn() })
    expect(screen.queryByRole("menuitem", { name: "Mark ready" })).toBeNull()
  })

  it("closes only after the confirm dialog", async () => {
    const onClosePr = vi.fn()
    await open({ onClosePr })
    await userEvent.click(screen.getByRole("menuitem", { name: "Close PR" }))
    expect(onClosePr).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByRole("button", { name: "Close pull request" }))
    expect(onClosePr).toHaveBeenCalledTimes(1)
  })

  it("copies the branch from the menu", async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    await open({})
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy branch" }))
    expect(writeText).toHaveBeenCalledWith("fix/error")
  })
})

describe("PullRequestView sub-tabs", () => {
  const mixed: PullRequest = {
    ...pr,
    commits: 2,
    changedFiles: 5,
    checks: [
      { name: "Typecheck", status: "pass", detailsUrl: null, durationMs: 1 },
      { name: "Lint", status: "fail", detailsUrl: null, durationMs: 1 },
      { name: "E2E", status: "running", detailsUrl: null, durationMs: null }
    ]
  }

  it("labels tabs with counts from the data, in order", () => {
    render(<WidthTierValue width={600}><PullRequestView pr={mixed} connected onOpenFiles={() => {}} /></WidthTierValue>)
    const names = screen.getAllByRole("tab").map((tab) => tab.textContent)
    expect(names).toEqual(["Conversation", "Commits 2", "Files 5", "Checks 1/3"])
  })

  it("is a 28px underline strip", () => {
    render(<WidthTierValue width={600}><PullRequestView pr={mixed} connected /></WidthTierValue>)
    expect(screen.getByRole("tab", { name: "Commits 2" }).className).toContain("h-7")
  })

  it("renders commitItems under Commits", () => {
    render(<WidthTierValue width={600}><PullRequestView pr={mixed} connected /></WidthTierValue>)
    fireEvent.click(screen.getByRole("tab", { name: "Commits 2" }))
    expect(screen.getByText("fix error")).toBeTruthy()
  })

  it("switches tabs with the arrow keys", () => {
    render(<WidthTierValue width={600}><PullRequestView pr={mixed} connected /></WidthTierValue>)
    const conversation = screen.getByRole("tab", { name: "Conversation" })
    conversation.focus()
    fireEvent.keyDown(conversation, { key: "ArrowRight" })
    expect(screen.getByRole("tab", { name: "Commits 2" }).getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(screen.getByRole("tab", { name: "Commits 2" }), { key: "ArrowLeft" })
    expect(screen.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true")
  })
})

describe("PullRequestView draft side panel", () => {
  const draft: PullRequest = { ...pr, state: "draft", isDraft: true }
  const view = (props: Partial<React.ComponentProps<typeof PullRequestView>> = {}) =>
    render(<WidthTierValue width={1200}><PullRequestView pr={draft} connected {...props} /></WidthTierValue>)

  it("calls onMarkReady from the secondary Mark ready for review button", async () => {
    const onMarkReady = vi.fn()
    view({ onMarkReady })
    await userEvent.click(screen.getByRole("button", { name: "Mark ready for review" }))
    expect(onMarkReady).toHaveBeenCalledTimes(1)
  })

  it("shows the markReadyError inline", () => {
    view({ onMarkReady: vi.fn(), markReadyError: "GitHub said no" })
    expect(screen.getByText("GitHub said no")).toBeTruthy()
  })

  it("drops the Draft pill and button once the PR is ready", () => {
    render(<WidthTierValue width={1200}><PullRequestView pr={pr} connected onMarkReady={vi.fn()} /></WidthTierValue>)
    expect(screen.getByRole("heading", { level: 2 }).textContent).not.toContain("Draft")
    expect(screen.queryByRole("button", { name: "Mark ready for review" })).toBeNull()
  })
})
