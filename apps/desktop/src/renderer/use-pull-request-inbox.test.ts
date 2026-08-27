import type { Project, PullRequestListItem, Repo, Session } from "@jingler/core"
import { describe, expect, it, vi } from "vitest"

vi.mock("./rpc-client.js", () => ({ rpc: {} }))

import { pullRequestSessionTarget } from "./use-pull-request-inbox.js"

const pr: PullRequestListItem = {
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
  reviewRequestedFromViewer: false
}

const repos: ReadonlyArray<Repo> = [
  {
    name: "widget",
    path: "/repos/widget",
    defaultBranch: "main",
    currentBranch: "main",
    remoteUrl: "git@github.com:acme/widget.git",
    githubSlug: "acme/widget"
  },
  {
    name: "api",
    path: "/repos/api",
    defaultBranch: "main",
    currentBranch: "main",
    remoteUrl: "git@github.com:acme/api.git",
    githubSlug: "acme/api"
  }
]

const projects: ReadonlyArray<Project> = [{
  id: "project-widget",
  name: "widget",
  path: "/repos/widget",
  availability: "available",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
}]

const session = (id: string, repoPath: string): Session => ({
  id,
  repo: repoPath.split("/").at(-1) ?? "repo",
  repoPath,
  branch: "fix/token",
  title: id,
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: 42,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-01T00:00:00.000Z",
  chats: [],
  activeChatId: "chat-1",
  worktreePath: `/worktrees/${id}`,
  baseBranch: "main",
  mode: "auto"
}) as Session

describe("pullRequestSessionTarget", () => {
  it("matches linked sessions by repository path and pull request number", () => {
    const wrongRepository = session("session-api", "/repos/api")
    const matching = session("session-widget", "/repos/widget")

    expect(
      pullRequestSessionTarget(pr, repos, projects, [wrongRepository, matching])
    ).toEqual({ project: projects[0], session: matching })
  })
})
