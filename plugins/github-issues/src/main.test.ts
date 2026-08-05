import { describe, expect, it, vi } from "vitest"
import { fetchIssue, resolveRepository } from "./main.js"

const session = {
  accessToken: "ghs_installation_secret",
  apiBaseUrl: "https://api.github.com"
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  Response.json(body, init)

describe("fetchIssue responses", () => {
  it("uses GitHub REST in the host and normalizes paginated comments", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          number: 42,
          title: "Fix the widget",
          body: null,
          state: "open",
          html_url: "https://github.com/acme/widgets/issues/42",
          user: { login: "octocat" },
          labels: [{ name: "bug", color: "d73a4a" }],
          assignees: [{ login: "hubot" }],
          created_at: "2030-01-01T00:00:00Z"
        })
      )
      .mockResolvedValueOnce(
        json([{ body: "First", user: { login: "mona" }, created_at: "2030-01-02T00:00:00Z" }], {
          headers: {
            link: '<https://api.github.com/repos/acme/widgets/issues/42/comments?per_page=100&page=2>; rel="next"'
          }
        })
      )
      .mockResolvedValueOnce(
        json([{ body: "Second", user: null, created_at: "2030-01-03T00:00:00Z" }])
      )

    await expect(fetchIssue({ repo: "acme/widgets", issueNumber: 42 }, session, request))
      .resolves.toMatchObject({
        number: 42,
        body: "",
        author: { login: "octocat" },
        labels: [{ name: "bug", color: "d73a4a" }],
        assignees: [{ login: "hubot" }],
        comments: [
          { body: "First", author: { login: "mona" } },
          { body: "Second" }
        ]
      })
    expect(request).toHaveBeenCalledTimes(3)
    for (const call of request.mock.calls) {
      expect(call[1]?.headers).toMatchObject({
        authorization: "Bearer ghs_installation_secret",
        "x-github-api-version": "2022-11-28"
      })
    }
  })

})

describe("fetchIssue boundaries", () => {
  it("rejects relay endpoints before sending a credential", async () => {
    const request = vi.fn<typeof fetch>()
    await expect(
      fetchIssue(
        { repo: "acme/widgets", issueNumber: 42 },
        { ...session, apiBaseUrl: "https://relay.jingler.test" },
        request
      )
    ).rejects.toThrow("GitHub API connection is unavailable")
    expect(request).not.toHaveBeenCalled()
  })

  it("does not include credentials or GitHub response bodies in failures", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json({ message: "failure containing ghs_installation_secret" }, { status: 500 })
    )
    await expect(
      fetchIssue({ repo: "acme/widgets", issueNumber: 42 }, session, request)
    ).rejects.toThrow("GitHub could not load this issue (HTTP 500).")
  })

  it("validates repository and issue inputs without making a request", async () => {
    const request = vi.fn<typeof fetch>()
    await expect(
      fetchIssue({ repo: "https://github.com/acme/widgets", issueNumber: 42 }, session, request)
    ).rejects.toThrow("repository is invalid")
    await expect(
      fetchIssue({ repo: "acme/widgets", issueNumber: 0 }, session, request)
    ).rejects.toThrow("issue number is invalid")
    expect(request).not.toHaveBeenCalled()
  })
})

describe("resolveRepository", () => {
  it("keeps owner/repo snapshots without invoking git", async () => {
    const exec = vi.fn()
    await expect(resolveRepository("acme/widgets", "/worktree", exec)).resolves.toBe(
      "acme/widgets"
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it.each([
    "https://github.com/acme/widgets.git",
    "git@github.com:acme/widgets.git",
    "ssh://git@github.com/acme/widgets.git"
  ])("resolves a folder-only session from GitHub origin %s", async (remote) => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: `${remote}\n`, stderr: "" })
    await expect(resolveRepository("widgets", "/worktree", exec)).resolves.toBe("acme/widgets")
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: "/worktree", timeoutMs: 5_000 }
    )
  })

  it("rejects non-GitHub origins without exposing command output", async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "ssh://git@internal.invalid/token-in-path/widgets.git",
      stderr: "secret diagnostic"
    })
    await expect(resolveRepository("widgets", "/worktree", exec)).rejects.toThrow(
      "origin is not a GitHub repository"
    )
  })
})
