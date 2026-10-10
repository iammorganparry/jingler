import type { IssueListItem, Project, Repo, Session } from "@jingler/core"
import { describe, expect, it, vi } from "vitest"

vi.mock("./rpc-client.js", () => ({ rpc: {} }))

import { issueSessionTarget, selectedIssueFor } from "./use-issue-inbox.js"

const issue = (repository: string, number: number): IssueListItem => ({
  providerId: "github", id: String(number), identifier: `#${number}`, number, repository,
  title: "Crash", url: `https://github.com/${repository}/issues/${number}`, body: "", state: "open",
  labels: [], author: null, assignees: [], comments: 0, updatedAt: "2026-08-01T10:00:00.000Z"
})

const repos: ReadonlyArray<Repo> = [
  { name: "widget", path: "/repos/widget", defaultBranch: "main", currentBranch: "main", remoteUrl: "", githubSlug: "acme/widget" },
  { name: "api", path: "/repos/api", defaultBranch: "main", currentBranch: "main", remoteUrl: "", githubSlug: "acme/api" }
]
const projects: ReadonlyArray<Project> = [{
  id: "project-widget", name: "widget", path: "/repos/widget", availability: "available",
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z"
}]

const session = (id: string, repoPath: string, links: Partial<Session>): Session => ({
  id, repo: repoPath.split("/").at(-1), repoPath, branch: "b", title: id, status: "idle",
  diff: { added: 0, removed: 0 }, costUsd: 0, tokens: 0, updatedAt: "2026-08-01T00:00:00.000Z",
  chats: [], activeChatId: "chat-1", worktreePath: `/worktrees/${id}`, baseBranch: "main", mode: "auto",
  ...links
}) as Session

describe("issueSessionTarget", () => {
  const widget = issue("acme/widget", 7)
  const reference = (url: string) => ({ providerId: "github", id: "7", identifier: "#7", url, title: "Crash", labels: [] })

  it("finds a session linked through canonical linkedIssues", () => {
    const linked = session("s1", "/repos/widget", { linkedIssues: [reference(widget.url)] })
    expect(issueSessionTarget(widget, repos, projects, [linked])?.session).toBe(linked)
  })

  it("finds a session that still carries the legacy issueNumber", () => {
    const legacy = session("s2", "/repos/widget", { issueNumber: 7 })
    expect(issueSessionTarget(widget, repos, projects, [legacy])?.session).toBe(legacy)
  })

  it("does not match the same number in another repository", () => {
    const other = session("s3", "/repos/widget", { linkedIssues: [reference("https://github.com/acme/api/issues/7")] })
    expect(issueSessionTarget(widget, repos, projects, [other])?.session).toBeNull()
  })
})

describe("selectedIssueFor", () => {
  const selection = { issue: issue("acme/widget", 7), viewerLogin: "octocat" }
  it("keeps the selection only for the account that made it", () => {
    expect(selectedIssueFor(selection, "octocat")).toBe(selection.issue)
    expect(selectedIssueFor(selection, "someone-else")).toBeNull()
    expect(selectedIssueFor(selection, null)).toBeNull()
    expect(selectedIssueFor(null, "octocat")).toBeNull()
  })
})
