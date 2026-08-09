// @vitest-environment jsdom
import type { IssueReference, SessionSnapshot } from "@jingler/plugin-sdk"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LinearIssueDetail } from "./linear-issue-machine.js"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openExternal: vi.fn().mockResolvedValue(undefined),
  linkIssue: vi.fn().mockResolvedValue(undefined),
  unlinkIssue: vi.fn().mockResolvedValue(undefined),
  tier: "wide"
}))

vi.mock("@jingler/plugin-sdk", async (load) => {
  const actual = await load<typeof import("@jingler/plugin-sdk")>()
  return {
    ...actual,
    useHost: () => ({
      invoke: mocks.invoke,
      openExternal: mocks.openExternal,
      storage: {},
      sessions: { linkIssue: mocks.linkIssue, unlinkIssue: mocks.unlinkIssue }
    }),
    useSessionActions: () => ({
      linkIssue: mocks.linkIssue,
      unlinkIssue: mocks.unlinkIssue
    })
  }
})

vi.mock("@jingler/plugin-sdk/ui", async (load) => {
  const actual = await load<typeof import("@jingler/plugin-sdk/ui")>()
  return { ...actual, useWidthTier: () => mocks.tier }
})

import { IssueTab } from "./ui.js"

const linkedIssue: IssueReference = {
  providerId: "linear",
  id: "issue-123",
  identifier: "ENG-123",
  url: "https://linear.app/acme/issue/ENG-123",
  title: "Retry failed payments",
  labels: [{ name: "bug", color: null }]
}

const session = (issue?: IssueReference): SessionSnapshot => ({
  id: "session-1",
  repo: "acme/web",
  branch: "eng-123",
  title: "Retry failed payments",
  cli: "codex",
  prNumber: null,
  linkedIssue: issue,
  worktreePath: "/tmp/acme-web"
})

const detail: LinearIssueDetail = {
  ...linkedIssue,
  state: "open",
  body: "Payment retries stop after the first failure.",
  author: { id: "user-1", name: "Morgan", avatarUrl: null },
  assignees: [{ id: "user-2", name: "Alex", avatarUrl: null }],
  updatedAt: "2026-08-09T10:00:00.000Z",
  createdAt: "2026-08-08T10:00:00.000Z",
  comments: [{
    id: "comment-1",
    author: { id: "user-3", name: "Sam", avatarUrl: null },
    body: "I can reproduce this.",
    createdAt: "2026-08-09T11:00:00.000Z"
  }],
  statusName: "In Progress",
  priority: { value: 2, label: "High" },
  team: { id: "team-1", name: "Engineering", key: "ENG" },
  project: { id: "project-1", name: "Reliability" },
  cycle: { id: "cycle-1", name: "August" }
}

const context = {
  viewer: { id: "user-1", name: "Morgan", avatarUrl: null },
  workspace: { id: "workspace-1", name: "Acme", urlKey: "acme" },
  teams: [{ id: "team-1", name: "Engineering", key: "ENG" }]
}

function successfulHost(command: string): unknown {
  if (command === "linear.configured") return true
  if (command === "linear.context") return context
  if (command === "linear.get") return detail
  if (command === "linear.list") return [detail]
  if (command === "linear.create") return detail
  if (command === "linear.comment") return detail.comments[0]
  throw new Error(`Unexpected command ${command}`)
}

beforeEach(() => {
  mocks.invoke.mockImplementation((command: string) => Promise.resolve(successfulHost(command)))
  mocks.openExternal.mockClear()
  mocks.linkIssue.mockClear()
  mocks.unlinkIssue.mockClear()
  mocks.tier = "wide"
})

afterEach(cleanup)

describe("Linear Issue tab content", () => {
  it("renders issue metadata, description, and comments", async () => {
    render(<IssueTab pluginId="linear" session={session(linkedIssue)} />)

    expect(await screen.findByRole("heading", { name: "Retry failed payments" })).toBeTruthy()
    expect(screen.getByText("Payment retries stop after the first failure.")).toBeTruthy()
    expect(screen.getByText("I can reproduce this.")).toBeTruthy()
    expect(screen.getByText("In Progress")).toBeTruthy()
    expect(screen.getByText("High")).toBeTruthy()
    expect(screen.getByText("Alex")).toBeTruthy()
    expect(screen.getByText("Reliability")).toBeTruthy()
    expect(screen.getByText("August")).toBeTruthy()
  })

  it("renders create and link controls for an unlinked session", async () => {
    render(<IssueTab pluginId="linear" session={session()} />)

    const search = await screen.findByLabelText("Search Linear issues")
    expect(screen.getByRole("heading", { name: "Create an issue" })).toBeTruthy()
    expect(screen.getByLabelText("Team")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Create and link" })).toBeTruthy()
    fireEvent.change(search, { target: { value: "payments" } })
    fireEvent.submit(search.closest("form") ?? search)

    const link = await screen.findByRole("button", { name: "Link ENG-123" })
    fireEvent.click(link)
    await waitFor(() => expect(mocks.linkIssue).toHaveBeenCalledWith("session-1", linkedIssue))
  })
})

describe("Linear Issue tab states", () => {
  it("renders actionable authentication and rate-limit errors", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "linear.configured") return Promise.resolve(false)
      return Promise.resolve(successfulHost(command))
    })
    const view = render(<IssueTab pluginId="linear" session={session()} />)

    expect(await screen.findByRole("heading", { name: "Connect Linear" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Create API key" })).toBeTruthy()

    view.unmount()
    mocks.invoke.mockRejectedValue(new Error("Linear rate limit reached. Try again later."))
    render(<IssueTab pluginId="linear" session={session(linkedIssue)} />)
    expect((await screen.findByRole("alert")).textContent).toContain("Linear rate limit reached")
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
  })

  it("keeps primary actions accessible at narrow width", async () => {
    mocks.tier = "narrow"
    render(<IssueTab pluginId="linear" session={session(linkedIssue)} />)

    await screen.findByRole("heading", { name: "Retry failed payments" })
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Open in Linear" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy()
  })

  it("renders empty descriptions and deleted users safely", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "linear.get") {
        return Promise.resolve({
          ...detail,
          body: "",
          comments: [{ ...detail.comments[0], author: null }]
        })
      }
      return Promise.resolve(successfulHost(command))
    })
    render(<IssueTab pluginId="linear" session={session(linkedIssue)} />)

    expect(await screen.findByText("No description provided.")).toBeTruthy()
    expect(screen.getByText("Deleted user")).toBeTruthy()
  })
})
