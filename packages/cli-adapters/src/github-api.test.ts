import { describe, expect, it, vi } from "vitest"
import { makeGitHubApiClient, parseGitHubRemote } from "./github-api.js"
import type { GitHubApiClientOptions } from "./github-api.js"

interface SeenRequest {
  readonly method: string
  readonly url: URL
  readonly headers: Headers
  readonly body: unknown
}

const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response =>
  new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status,
    headers: {
      "content-type": typeof value === "string" ? "text/plain" : "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-used": "1",
      "x-ratelimit-reset": "1893456000",
      ...headers
    }
  })

const requestOf = async (input: string | URL | Request, init?: RequestInit): Promise<SeenRequest> => {
  const source = input instanceof Request ? input : null
  const headers = new Headers(source?.headers)
  new Headers(init?.headers).forEach((value, key) => {
    headers.set(key, value)
  })
  const rawBody = init?.body ?? (source ? await source.clone().text() : null)
  let body: unknown = rawBody
  if (typeof rawBody === "string" && rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody)
    } catch {
      body = rawBody
    }
  }
  return {
    method: init?.method ?? source?.method ?? "GET",
    url: new URL(source?.url ?? String(input)),
    headers,
    body
  }
}

const repository = {
  id: 101,
  node_id: "R_widget",
  full_name: "acme/widget",
  private: true
}

const makeClient = (
  handler: (request: SeenRequest) => Promise<Response> | Response,
  overrides: Partial<GitHubApiClientOptions> = {}
) => {
  const seen: SeenRequest[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await requestOf(input, init)
    seen.push(request)
    return handler(request)
  }
  const invalidated: string[] = []
  const credentialRequests: Array<{
    readonly owner: string
    readonly repository: string
    readonly permissions: ReadonlyArray<string>
  }> = []
  const client = makeGitHubApiClient({
    auth: {
      viewerLogin: async () => "octocat",
      credentialsForOwner: async (owner, repository, permissions) => {
        credentialRequests.push({ owner, repository, permissions })
        return {
          token: "short-lived-installation-token",
          installationId: "77",
          expiresAt: "2030-01-01T00:00:00.000Z"
        }
      },
      invalidate: (installationId) => invalidated.push(installationId)
    },
    remoteUrl: async () => "git@github.com:acme/widget.git",
    branch: async () => "feature/api",
    git: async () => "",
    gitText: async () => null,
    fetch,
    ...overrides
  })
  return { client, seen, invalidated, credentialRequests }
}

const pathIs = (request: SeenRequest, pathname: string): boolean =>
  request.url.pathname === pathname

describe("GitHubApi remote and repository identity", () => {
  it.each([
    ["git@github.com:acme/widget.git", { owner: "acme", repo: "widget" }],
    ["ssh://git@github.com/acme/widget.git", { owner: "acme", repo: "widget" }],
    ["https://github.com/acme/widget", { owner: "acme", repo: "widget" }]
  ])("parses %s", (remote, expected) => {
    expect(parseGitHubRemote(remote)).toEqual(expected)
  })

  it("resolves and caches an immutable repository id", async () => {
    const { client, seen, credentialRequests } = makeClient(() => json(repository))
    await expect(client.repository("/repo")).resolves.toMatchObject({
      id: "101",
      nodeId: "R_widget",
      fullName: "acme/widget",
      installationId: "77"
    })
    await client.repository("/repo")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer short-lived-installation-token")
    expect(credentialRequests).toEqual([{
      owner: "acme",
      repository: "acme/widget",
      permissions: ["contents:read"]
    }])
    expect(seen[0]?.headers.get("x-github-api-version")).toBe("2022-11-28")
  })

  it("matches a branch only from the exact head repository", async () => {
    const { client, seen } = makeClient((request) => {
      if (pathIs(request, "/repos/acme/widget")) return json(repository)
      if (pathIs(request, "/repos/acme/widget/pulls")) {
        return json([
          {
            number: 40,
            head: {
              ref: "feat/shared-name",
              repo: { id: 999, full_name: "contributor/widget" }
            }
          },
          {
            number: 41,
            head: {
              ref: "feat/shared-name",
              repo: { id: 101, full_name: "acme/widget" }
            }
          }
        ])
      }
      throw new Error(`unexpected ${request.method} ${request.url}`)
    })

    await expect(client.prForBranch("/repo", "feat/shared-name")).resolves.toBe(41)
    const request = seen.find((candidate) => pathIs(candidate, "/repos/acme/widget/pulls"))
    expect(request?.url.searchParams.get("head")).toBe("acme:feat/shared-name")
  })

  it("does not accept a same-named fork branch when the exact head is absent", async () => {
    const { client } = makeClient((request) => {
      if (pathIs(request, "/repos/acme/widget")) return json(repository)
      if (pathIs(request, "/repos/acme/widget/pulls")) {
        return json([{
          number: 40,
          head: {
            ref: "feat/shared-name",
            repo: { id: 999, full_name: "contributor/widget" }
          }
        }])
      }
      throw new Error(`unexpected ${request.method} ${request.url}`)
    })

    await expect(client.prForBranch("/repo", "feat/shared-name")).resolves.toBeNull()
  })
})

describe("GitHubApi pagination and large pull requests", () => {
  it("fails explicitly instead of silently truncating a capped pagination stream", async () => {
    const { client, seen } = makeClient((request) => {
      if (pathIs(request, "/repos/acme/widget")) return json(repository)
      if (pathIs(request, "/repos/acme/widget/pulls/6/files")) {
        return json(
          Array.from({ length: 100 }, (_, index) => ({
            filename: `src/page-file-${index}.ts`,
            additions: 1,
            deletions: 0
          }))
        )
      }
      throw new Error(`unexpected ${request.method} ${request.url}`)
    })

    await expect(client.prFiles("/repo", 6)).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining("more results")
    })
    expect(
      seen.filter((request) => pathIs(request, "/repos/acme/widget/pulls/6/files"))
    ).toHaveLength(100)
  })

  it("keeps every file after page 1 in the review surface", async () => {
    const { client, seen } = makeClient((request) => {
      if (pathIs(request, "/repos/acme/widget")) return json(repository)
      if (pathIs(request, "/repos/acme/widget/pulls/7/files")) {
        const page = Number(request.url.searchParams.get("page"))
        const start = page === 1 ? 0 : 100
        const length = page === 1 ? 100 : 35
        return json(
          Array.from({ length }, (_, index) => ({
            filename: `src/file-${start + index}.ts`,
            additions: 1,
            deletions: 0
          }))
        )
      }
      throw new Error(`unexpected ${request.method} ${request.url}`)
    })

    const files = await client.prFiles("/repo", 7)
    expect(files).toHaveLength(135)
    expect(files.at(-1)?.path).toBe("src/file-134.ts")
    expect(
      seen.filter((request) => pathIs(request, "/repos/acme/widget/pulls/7/files"))
    ).toHaveLength(2)
  })

  it("falls back from an oversized aggregate diff to every paginated file patch", async () => {
    const { client } = makeClient((request) => {
      if (pathIs(request, "/repos/acme/widget")) return json(repository)
      if (pathIs(request, "/repos/acme/widget/pulls/9") && request.headers.get("accept")?.includes("diff")) {
        return json({ message: "diff too large" }, 406)
      }
      if (pathIs(request, "/repos/acme/widget/pulls/9/files")) {
        const page = Number(request.url.searchParams.get("page"))
        const start = page === 1 ? 0 : 100
        const length = page === 1 ? 100 : 1
        return json(
          Array.from({ length }, (_, index) => ({
            filename: `src/large-${start + index}.ts`,
            patch: "@@ -0,0 +1 @@\n+export const value = 1"
          }))
        )
      }
      throw new Error(`unexpected ${request.method} ${request.url}`)
    })

    const diff = await client.prDiff("/repo", 9)
    expect(diff).toContain("diff --git a/src/large-0.ts b/src/large-0.ts")
    expect(diff).toContain("diff --git a/src/large-100.ts b/src/large-100.ts")
  })
})

describe("GitHubApi installation permission scopes", () => {
  it("uses connection identity for mine filters and requests endpoint-specific permissions", async () => {
    const { client, seen, credentialRequests } = makeClient((request) => {
      if (pathIs(request, "/repos/acme/widget")) return json(repository)
      if (pathIs(request, "/repos/acme/widget/issues")) {
        return json([
          {
            number: 10,
            title: "Assigned issue",
            user: { login: "author" },
            assignees: [{ login: "octocat" }]
          },
          {
            number: 11,
            title: "Someone else's issue",
            user: { login: "author" },
            assignees: [{ login: "someone-else" }]
          }
        ])
      }
      if (pathIs(request, "/repos/acme/widget/issues/10")) {
        return json({
          number: 10,
          title: "Assigned issue",
          state: "open",
          user: { login: "author" },
          assignees: [{ login: "octocat" }]
        })
      }
      if (pathIs(request, "/repos/acme/widget/issues/10/comments")) {
        return json([{ body: "Issue context", user: { login: "maintainer" } }])
      }
      throw new Error(`unexpected ${request.method} ${request.url}`)
    })

    await expect(client.listIssues("/repo", { mine: true, search: "" })).resolves.toEqual([
      expect.objectContaining({ number: 10, title: "Assigned issue" })
    ])
    await expect(client.issueView("/repo", 10)).resolves.toMatchObject({
      number: 10,
      comments: [
        expect.objectContaining({
          author: expect.objectContaining({ login: "maintainer" }),
          body: "Issue context"
        })
      ]
    })
    expect(seen.some((request) => request.url.pathname === "/user")).toBe(false)
    expect(credentialRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ permissions: ["contents:read"] }),
        expect.objectContaining({ permissions: ["issues:read"] })
      ])
    )
  })

  it("does not broaden Mine results when the connected identity is unavailable", async () => {
    const { client, seen } = makeClient(
      (request) => {
        if (pathIs(request, "/repos/acme/widget")) return json(repository)
        if (pathIs(request, "/repos/acme/widget/pulls")) {
          return json([{ number: 1, title: "Not implicitly mine", user: { login: "someone" } }])
        }
        throw new Error(`unexpected ${request.method} ${request.url}`)
      },
      {
        auth: {
          viewerLogin: async () => null,
          credentialsForOwner: async () => ({
            token: "short-lived-installation-token",
            installationId: "77",
            expiresAt: "2030-01-01T00:00:00.000Z"
          }),
          invalidate: () => undefined
        }
      }
    )

    await expect(client.listPrs("/repo", { mine: true, search: "" })).resolves.toEqual([])
    expect(seen.some((request) => request.url.pathname === "/user")).toBe(false)
  })

  it("mints separate pull-request, checks, and status credentials for PR state", async () => {
    const { client, credentialRequests, seen } = makeClient((request) => {
      if (pathIs(request, "/repos/acme/widget")) return json(repository)
      if (pathIs(request, "/repos/acme/widget/pulls/7")) {
        return json({ number: 7, state: "open", head: { sha: "abc123" } })
      }
      if (pathIs(request, "/repos/acme/widget/commits/abc123/check-runs")) {
        return json({ check_runs: [] })
      }
      if (pathIs(request, "/repos/acme/widget/commits/abc123/status")) {
        const page = Number(request.url.searchParams.get("page"))
        return json({
          statuses: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
            context: `status-${page}-${index}`,
            state: "success"
          }))
        })
      }
      throw new Error(`unexpected ${request.method} ${request.url}`)
    })

    await client.prState("/repo", 7)
    expect(credentialRequests.map((request) => request.permissions)).toEqual(
      expect.arrayContaining([
        ["pull_requests:read"],
        ["checks:read"],
        ["statuses:read"]
      ])
    )
    expect(
      seen.filter((request) => pathIs(request, "/repos/acme/widget/commits/abc123/status"))
    ).toHaveLength(2)
  })

  it("uses the documented minimum write permissions for PR mutations", async () => {
    const { client, credentialRequests } = makeClient((request) => {
      if (pathIs(request, "/repos/acme/widget")) return json(repository)
      return json({ merged: true })
    })

    await client.prMerge("/repo", 7, "squash")
    await client.prUpdateBranch("/repo", 7)
    await client.prComment("/repo", 7, "ship it")

    expect(credentialRequests.map(({ permissions }) => permissions)).toEqual([
      ["contents:read"],
      ["contents:write"],
      ["pull_requests:write", "contents:write"],
      ["pull_requests:write"]
    ])
  })
})

describe("GitHubApi typed failures", () => {
  it.each([
    [401, { message: "Bad credentials" }, "token-expired"],
    [403, { message: "installation suspended" }, "installation-suspended"],
    [403, { message: "Resource not accessible by integration" }, "repository-access"],
    [422, { message: "Validation Failed" }, "validation"]
  ] as const)("maps HTTP %s to %s", async (status, body, reason) => {
    const { client, invalidated } = makeClient(() => json(body, status))
    await expect(client.repository("/repo")).rejects.toMatchObject({
      _tag: "GitHubApiError",
      reason,
      status
    })
    expect(invalidated).toEqual(reason === "token-expired" ? ["77"] : [])
  })

  it("includes the reset time on a rate-limit error", async () => {
    const { client } = makeClient(() =>
      json(
        { message: "API rate limit exceeded" },
        429,
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" }
      )
    )
    await expect(client.repository("/repo")).rejects.toMatchObject({
      reason: "rate-limited",
      retryAt: "2030-01-01T00:00:00.000Z"
    })
  })

  it("maps a primary-limit 403 to retry guidance rather than repository access", async () => {
    const { client } = makeClient(() =>
      json(
        { message: "API rate limit exceeded" },
        403,
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" }
      )
    )
    await expect(client.repository("/repo")).rejects.toMatchObject({
      reason: "rate-limited",
      retryAt: "2030-01-01T00:00:00.000Z"
    })
  })

  it("maps a secondary-limit 403 Retry-After header to an actionable retry time", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"))
    try {
      const { client } = makeClient(() =>
        json(
          { message: "You have exceeded a secondary rate limit." },
          403,
          { "x-ratelimit-remaining": "4999", "retry-after": "90" }
        )
      )
      await expect(client.repository("/repo")).rejects.toMatchObject({
        reason: "rate-limited",
        retryAt: "2030-01-01T00:01:30.000Z"
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("GitHubApi writes and fork metadata", () => {
  it("normalizes review payloads and every supported write to typed HTTP requests", async () => {
    const writes: SeenRequest[] = []
    const git = vi.fn(async () => "")
    const { client, credentialRequests } = makeClient(
      (request) => {
        if (pathIs(request, "/repos/acme/widget") && request.method === "GET") {
          return json(repository)
        }
        if (pathIs(request, "/repos/acme/widget/pulls/7") && request.method === "GET") {
          return json({
            number: 7,
            node_id: "PR_7",
            state: "open",
            head: {
              ref: "feature/fork",
              sha: "abc123",
              repo: {
                id: 303,
                full_name: "contributor/widget",
                clone_url: "https://github.com/contributor/widget.git",
                ssh_url: "git@github.com:contributor/widget.git"
              }
            }
          })
        }
        writes.push(request)
        if (pathIs(request, "/repos/acme/widget/pulls") && request.method === "POST") {
          return json({ number: 88 })
        }
        return json({ data: {} })
      },
      { git }
    )

    await expect(client.prCheckout("/repo", 7)).resolves.toMatchObject({
      repositoryId: "303",
      fullName: "contributor/widget",
      ref: "feature/fork",
      cloneUrl: "https://github.com/contributor/widget.git"
    })
    await client.prReviewComments("/repo", 7, {
      commitSha: "abc123",
      body: "summary",
      comments: [
        { path: "a.ts", line: 3, startLine: null, body: "single" },
        { path: "b.ts", line: 8, startLine: 5, body: "range" }
      ]
    })
    await client.prReview("/repo", 7, "approve", "looks good")
    await client.prUpdate("/repo", 7, { title: "Updated title", body: "Updated body" })
    await client.resolveThread("/repo", "THREAD_1", true)
    await client.replyToThread("/repo", 7, 42, "reply")
    await client.prMerge("/repo", 7, "squash")
    await client.prUpdateBranch("/repo", 7)
    await client.prReady("/repo", 7)
    await client.prComment("/repo", 7, "comment")
    await client.issueComment("/repo", 12, "issue comment")
    await client.closeIssue("/repo", 12)
    await expect(
      client.prCreate("/repo", { title: "Title", body: "Body", base: "main", draft: true })
    ).resolves.toBe(88)

    const review = writes.find(
      (request) =>
        request.method === "POST" &&
        pathIs(request, "/repos/acme/widget/pulls/7/reviews") &&
        (request.body as Record<string, unknown>).commit_id === "abc123"
    )
    expect(review?.body).toMatchObject({
      commit_id: "abc123",
      event: "COMMENT",
      comments: [
        { path: "a.ts", line: 3, side: "RIGHT", body: "single" },
        {
          path: "b.ts",
          line: 8,
          start_line: 5,
          start_side: "RIGHT",
          side: "RIGHT",
          body: "range"
        }
      ]
    })
    expect(
      writes.find(
        (request) =>
          request.method === "PATCH" && pathIs(request, "/repos/acme/widget/pulls/7")
      )?.body
    ).toMatchObject({ title: "Updated title", body: "Updated body" })
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "PUT" }),
        expect.objectContaining({ method: "PATCH" })
      ])
    )
    expect(credentialRequests.map(({ permissions }) => permissions)).toEqual([
      ["contents:read"],
      ["pull_requests:read"],
      ["pull_requests:write"],
      ["pull_requests:write"],
      ["pull_requests:write"],
      ["pull_requests:write"],
      ["pull_requests:write"],
      ["contents:write"],
      ["pull_requests:write", "contents:write"],
      ["pull_requests:read"],
      ["pull_requests:write"],
      ["pull_requests:write"],
      ["issues:write"],
      ["issues:write"],
      ["pull_requests:write"]
    ])
    // GitHubApi owns HTTP only. The deterministic publisher performs the
    // authenticated push through GitService before creating the PR.
    expect(git).not.toHaveBeenCalled()
  })
})
