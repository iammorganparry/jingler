import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { GitHubCli, ghCallLabel, resetGhRateGate } from "./github-cli.js"
import { fakeCommandExecutor } from "./test-support.js"

const run = <A>(effect: Effect.Effect<A, unknown, unknown>, handler: Parameters<typeof fakeCommandExecutor>[0]): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(GitHubCli.Default, fakeCommandExecutor(handler))) as never)) as Promise<A>

const commitPages = (args: ReadonlyArray<string>) => {
  if (!args.join(" ").includes("commits(first:100")) return undefined
  expect(args.join(" ")).toContain("authors(first:1){nodes{name user{login}}}")
  expect(args.join(" ")).toContain("signature{isValid}")
  const commit = (oid: string) => ({ commit: {
    oid,
    messageHeadline: oid === "abc" ? "ship it" : "ship more",
    committedDate: "2026-08-26T08:00:00Z",
    url: `https://github.com/acme/widget/commit/${oid}`,
    authors: { nodes: [{ name: "Octo Cat", user: { login: "octocat" } }] },
    signature: { isValid: true }
  } })
  return { stdout: JSON.stringify([
    { data: { repository: { pullRequest: { commits: {
      nodes: [commit("abc")],
      pageInfo: { hasNextPage: true, endCursor: "commits-2" }
    } } } } },
    { data: { repository: { pullRequest: { commits: {
      nodes: [commit("def")],
      pageInfo: { hasNextPage: false, endCursor: null }
    } } } } }
  ]) }
}

describe("GitHubCli", () => {
  it("detects an authenticated CLI by running gh directly", async () => {
    const commands: string[] = []
    await expect(run(GitHubCli.available(), (command, args) => {
      commands.push(command)
      if (command === "gh" && args[0] === "auth") return { stdout: "github.com\n" }
      return
    })).resolves.toBe(true)
    expect(commands).toEqual(["gh"])
  })

  it("caches gh auth status instead of asking before every call", async () => {
    resetGhRateGate()
    let probes = 0
    const handler: Parameters<typeof fakeCommandExecutor>[0] = (command, args) => {
      if (command === "gh" && args[0] === "auth") { probes++; return { stdout: "github.com\n" } }
      return
    }
    await expect(run(GitHubCli.available(), handler)).resolves.toBe(true)
    await expect(run(GitHubCli.available(), handler)).resolves.toBe(true)
    expect(probes).toBe(1)
    resetGhRateGate()
  })

  it("shares one in-flight gh auth status across concurrent callers", async () => {
    resetGhRateGate()
    let probes = 0
    const results = await run(Effect.all(Array.from({ length: 5 }, () => GitHubCli.available()), { concurrency: "unbounded" }), (command, args) => {
      if (command === "gh" && args[0] === "auth") { probes++; return { stdout: "github.com\n" } }
      return
    })
    expect(results).toEqual([true, true, true, true, true])
    expect(probes).toBe(1)
    resetGhRateGate()
  })

  it("does not cache a signed-out result past the next gh auth login", async () => {
    resetGhRateGate()
    let signedIn = false
    const handler: Parameters<typeof fakeCommandExecutor>[0] = (command, args) =>
      command === "gh" && args[0] === "auth" ? (signedIn ? { stdout: "github.com\n" } : { exitCode: 1, stderr: "not logged in" }) : undefined
    await expect(run(GitHubCli.available(), handler)).resolves.toBe(false)
    signedIn = true
    await expect(run(GitHubCli.available(), handler)).resolves.toBe(true)
    resetGhRateGate()
  })

  it("labels gh calls from a fixed set so endpoints never become counter keys", () => {
    expect(ghCallLabel(["api", "repos/acme/widget"])).toBe("api rest")
    expect(ghCallLabel(["api", "-X", "POST", "repos/acme/widget/pulls"])).toBe("api rest")
    expect(ghCallLabel(["api", "graphql", "-f", "query=x"])).toBe("api graphql")
    expect(ghCallLabel(["api", "search/issues"])).toBe("api search")
    expect(ghCallLabel(["pr", "view", "42", "--json", "state"])).toBe("pr view")
  })

  it("reports an unavailable or signed-out CLI", async () => {
    resetGhRateGate()
    await expect(run(GitHubCli.available(), (command) =>
      command === "gh" ? { exitCode: 1, stderr: "not logged in" } : undefined
    )).resolves.toBe(false)
  })

  it("personal search maps relationships and facets into one GraphQL page", async () => {
    let body: { variables: { q: string } } | null = null
    const result = await run(GitHubCli.prSearch({
      filters: { relationship: "review-requested", repository: "acme/widget", author: "", label: "", draft: "ready", text: "" },
      team: null, after: null, refresh: false
    }), (command, args, stdin) => {
      if (command !== "gh" || args[1] !== "graphql") return
      body = JSON.parse(stdin)
      return { stdout: JSON.stringify({ data: { viewer: { login: "octocat" }, rateLimit: { remaining: 4000, resetAt: "2026-11-04T11:00:00Z" },
        search: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
          number: 101, repository: { nameWithOwner: "acme/widget" }, title: "PR", url: "https://github.com/acme/widget/pull/101",
          assignees: { nodes: [{ login: "OCTOCAT" }] }, reviewRequests: { nodes: [{ requestedReviewer: { login: "octocat" } }] }
        }] } } }) }
    })
    expect(body!.variables.q).toBe("is:pr is:open review-requested:@me repo:acme/widget draft:false sort:updated-desc")
    expect(result.prs[0]).toMatchObject({ assignedToViewer: true, reviewRequestedFromViewer: true })
  })

  it("prsByKey fetches linked PRs by alias and drops ones that no longer resolve", async () => {
    const result = await run(GitHubCli.prsByKey([{ repository: "acme/widget", number: 1 }, { repository: "acme/gone", number: 2 }]), (command, args) => {
      if (command !== "gh" || args[1] !== "graphql") return
      return { exitCode: 1, stderr: "Could not resolve", stdout: JSON.stringify({ data: { viewer: { login: "octocat" },
        p0: { pullRequest: { number: 1, repository: { nameWithOwner: "acme/widget" }, title: "Linked" } }, p1: null } }) }
    })
    expect(result.map((pr) => pr.number)).toEqual([1])
  })

  it("home merges direct requests into the pool and treats only a missing picked node as an answer", async () => {
    const node = (id: string, createdAt: string) => ({ id, number: 1, title: id, url: "u", repository: { nameWithOwner: "acme/widget" }, state: "OPEN", createdAt })
    const reply = (errors: unknown[]) => ({ exitCode: errors.length ? 1 : 0, stdout: JSON.stringify({ data: {
      viewer: { login: "me" }, open: { issueCount: 0, nodes: [] }, closed: { issueCount: 0, nodes: [] },
      pool: { nodes: [node("PR_team", "2026-01-01T00:00:00Z")] }, direct: { nodes: [node("PR_direct", "2026-11-01T00:00:00Z")] },
      picked: [null]
    }, errors }) })
    const ok = await run(GitHubCli.home({ picked: ["MDExOlB1bGxSZXF1ZXN0MQ=="], closedSince: "2026-10-28" }), (command) =>
      command === "gh" ? reply([{ type: "NOT_FOUND", path: ["picked", 0] }]) : undefined)
    expect(ok.reviewPool.map((pr) => [pr.id, pr.directRequest])).toEqual([["PR_direct", true], ["PR_team", false]])
    expect(ok.picked).toEqual([null])
    await expect(run(GitHubCli.home({ picked: [], closedSince: "2026-10-28" }), (command) =>
      command === "gh" ? reply([{ type: "SERVICE_UNAVAILABLE", path: ["pool"] }]) : undefined)).rejects.toThrow("partial result")
  })

  it("paginates the issue inbox and tags rows with repository and comment count", async () => {
    const result = await run(GitHubCli.issueInbox(), (command, args) => {
      if (command !== "gh" || args[0] !== "api") return
      expect(args).toEqual(expect.arrayContaining(["--paginate", "--slurp"]))
      expect(args.join(" ")).toContain("is:issue is:open involves:@me")
      expect(args.join(" ")).toContain("after:$endCursor")
      const issue = (number: number, repository: string) => ({
        number, repository: { nameWithOwner: repository }, title: `Issue ${number}`, state: "OPEN",
        url: `https://github.com/${repository}/issues/${number}`, updatedAt: "2026-08-01T10:00:00Z",
        author: { login: "octocat" }, comments: { totalCount: number },
        labels: { nodes: [{ name: "bug", color: "ff0000" }] }, assignees: { nodes: [{ login: "lee" }] }
      })
      return { stdout: JSON.stringify([
        { data: { viewer: { login: "octocat" }, search: { nodes: [issue(1, "acme/widget"), {}] } } },
        { data: { viewer: { login: "octocat" }, search: { nodes: [issue(2, "acme/api")] } } }
      ]) }
    })

    expect(result.viewerLogin).toBe("octocat")
    expect(result.warnings).toEqual([])
    expect(result.issues.map((row) => [row.repository, row.number, row.comments])).toEqual([
      ["acme/widget", 1, 1], ["acme/api", 2, 2]
    ])
    expect(result.issues[0]).toMatchObject({ title: "Issue 1", state: "open", labels: [{ name: "bug", color: "ff0000" }], assignees: [{ name: "lee" }] })
  })

  it("loads a PR and inline review threads through gh", async () => {
    const commands: Array<ReadonlyArray<string>> = []
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one fixture handles each gh subprocess in the PR read.
    const result = await run(GitHubCli.prView("/repo", 42), (command, args) => {
      if (command !== "gh") return
      commands.push(args)
      if (args[0] === "pr") return { stdout: JSON.stringify({
        state: "OPEN",
        number: 42,
        title: "CLI first",
        url: "https://github.com/acme/widget/pull/42",
        author: { login: "octocat" },
        commits: [{ oid: "abc", messageHeadline: "ship it", authors: [{ login: "octocat" }] }]
      }) }
      if (args[0] === "repo") return { stdout: "acme/widget\n" }
      const commits = commitPages(args)
      if (commits) return commits
      if (args[1] === "repos/acme/widget/pulls/42/files") return { stdout: "[[]]" }
      if (args[0] === "api") return { stdout: JSON.stringify([{
        data: { repository: { pullRequest: { reviewThreads: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null }
        } } } }
      }]) }
      return
    })

    expect(result).toMatchObject({ number: 42, title: "CLI first", commits: 2 })
    expect(result?.commitItems).toMatchObject([
      {
        sha: "abc",
        message: "ship it",
        author: "octocat",
        url: "https://github.com/acme/widget/commit/abc",
        verified: true
      },
      {
        sha: "def",
        message: "ship more",
        author: "octocat",
        url: "https://github.com/acme/widget/commit/def",
        verified: true
      }
    ])
    expect(commands.map((args) => args[0])).toEqual(["pr", "repo", "api", "api", "api"])
  })

  it("counts every file from the paginated files endpoint", async () => {
    const result = await run(GitHubCli.prViewBySlug("acme/widget", 42), (command, args) => {
      if (command !== "gh") return
      if (args[0] === "pr") {
        expect(args.at(-1)?.split(",")).not.toContain("files")
        return { stdout: JSON.stringify({ state: "OPEN", number: 42 }) }
      }
      if (args[1] === "repos/acme/widget/pulls/42/files") {
        expect(args).toEqual([
          "api", "repos/acme/widget/pulls/42/files", "--paginate", "--slurp"
        ])
        return { stdout: JSON.stringify([
          [{ filename: "one.ts" }, { filename: "two.ts" }],
          [{ filename: "three.ts" }]
        ]) }
      }
      if (args.join(" ").includes("commits(first:100")) return { stdout: JSON.stringify([{
        data: { repository: { pullRequest: { commits: {
          nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
        } } } }
      }]) }
      if (args[0] === "api") return { stdout: JSON.stringify([{
        data: { repository: { pullRequest: { reviewThreads: {
          nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
        } } } }
      }]) }
      return
    })

    expect(result.changedFiles).toBe(3)
  })

  it("paginates review threads and every comment in each thread", async () => {
    const comment = (id: string) => ({
      id,
      databaseId: Number(id.slice(1)),
      body: id,
      createdAt: "2030-01-01T00:00:00Z",
      author: { login: "octocat", __typename: "User" }
    })
    const thread = (id: string, comments: unknown, pageInfo: unknown) => ({
      id,
      path: "src/index.ts",
      comments: { nodes: comments, pageInfo }
    })
    const result = await run(GitHubCli.prViewBySlug("acme/widget", 42), (command, args) => {
      if (command !== "gh") return
      if (args[0] === "pr") return { stdout: JSON.stringify({
        state: "OPEN", number: 42, title: "Paginated", url: "https://github.com/acme/widget/pull/42"
      }) }
      const joined = args.join(" ")
      if (joined.includes("query($id:ID!")) {
        expect(args).toEqual(expect.arrayContaining(["--paginate", "--slurp", "endCursor=comments-2"]))
        return { stdout: JSON.stringify([{
          data: { node: { comments: {
            nodes: [comment("c2")],
            pageInfo: { hasNextPage: false, endCursor: null }
          } } }
        }]) }
      }
      if (joined.includes("commits(first:100")) return { stdout: JSON.stringify([{
        data: { repository: { pullRequest: { commits: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null }
        } } } }
      }]) }
      if (args[0] === "api") return { stdout: JSON.stringify([
        { data: { repository: { pullRequest: { reviewThreads: {
          nodes: [thread("t1", [comment("c1")], { hasNextPage: true, endCursor: "comments-2" })],
          pageInfo: { hasNextPage: true, endCursor: "threads-2" }
        } } } } },
        { data: { repository: { pullRequest: { reviewThreads: {
          nodes: [thread("t2", [comment("c3")], { hasNextPage: false, endCursor: null })],
          pageInfo: { hasNextPage: false, endCursor: null }
        } } } } }
      ]) }
      return
    })

    expect(result?.reviewThreads.map((thread) => thread.id)).toEqual(["t1", "t2"])
    expect(result?.reviewThreads[0]?.comments.map((comment) => comment.id)).toEqual(["c1", "c2"])
  })

  it("propagates review-thread failures instead of presenting an empty review", async () => {
    await expect(run(GitHubCli.prViewBySlug("acme/widget", 42), (command, args) => {
      if (command !== "gh") return
      if (args[0] === "pr") return { stdout: JSON.stringify({ state: "OPEN", number: 42 }) }
      if (args[0] === "api") return { exitCode: 1, stderr: "GraphQL rate limit reached" }
      return
    })).rejects.toThrow("GraphQL rate limit reached")
  })

  it("keeps PR bodies off argv", async () => {
    const calls: Array<{ args: ReadonlyArray<string>; stdin: string }> = []
    await run(GitHubCli.prUpdate("/repo", 42, { title: "Title", body: "private body" }),
      (command, args, stdin) => {
        if (command === "gh") calls.push({ args, stdin })
        return { stdout: "" }
      })
    expect(calls[0]?.args).toContain("--body-file")
    expect(calls[0]?.args).not.toContain("private body")
    expect(calls[0]?.stdin).toBe("private body")
  })

  it("keeps review bodies on stdin and preserves inline range payloads", async () => {
    const calls: Array<{ args: ReadonlyArray<string>; stdin: string }> = []
    await run(GitHubCli.prReviewComments("/repo", 42, {
      commitSha: "abc",
      body: "summary",
      comments: [{ path: "src/a.ts", startLine: 2, line: 4, body: "fix this" }]
    }), (command, args, stdin) => {
      if (command !== "gh") return
      calls.push({ args, stdin })
      if (args[0] === "repo") return { stdout: "acme/widget" }
      return { stdout: "{}" }
    })
    expect(calls[1]?.args).toEqual([
      "api", "-X", "POST", "repos/acme/widget/pulls/42/reviews", "--input", "-"
    ])
    expect(JSON.parse(calls[1]!.stdin)).toMatchObject({
      commit_id: "abc",
      event: "COMMENT",
      comments: [{ path: "src/a.ts", start_line: 2, line: 4, side: "RIGHT" }]
    })
  })

  it("matches branch PRs to the base repository instead of a same-named fork branch", async () => {
    const result = await run(GitHubCli.prForBranchBySlug("acme/widget", "feature"), (command, args) => {
      if (command !== "gh" || args[0] !== "pr") return
      return { stdout: JSON.stringify([
        { number: 1, headRefName: "feature", headRepository: { nameWithOwner: "fork/widget" } },
        { number: 2, headRefName: "feature", headRepository: { nameWithOwner: "acme/widget" } }
      ]) }
    })
    expect(result).toBe(2)
  })

  it("clones repositories through authenticated gh", async () => {
    const calls: ReadonlyArray<string>[] = []
    await run(GitHubCli.cloneRepository("acme/widget", "/projects/widget"), (command, args) => {
      if (command === "gh") calls.push(args)
      return { stdout: "" }
    })
    expect(calls).toEqual([["repo", "clone", "acme/widget", "/projects/widget"]])
  })

  it("lists repositories for CLI-only project cloning", async () => {
    const result = await run(GitHubCli.repositories(), (command, args) => {
      if (command !== "gh" || args[0] !== "api") return
      return { stdout: JSON.stringify([[
        { id: 7, full_name: "acme/widget" },
        { id: 8, full_name: "acme/gadget" }
      ]]) }
    })
    expect(result).toEqual([
      { repositoryId: "7", fullName: "acme/widget" },
      { repositoryId: "8", fullName: "acme/gadget" }
    ])
  })

  it("reads repository identity without an App installation", async () => {
    const result = await run(GitHubCli.repository("/repo"), (command, args) => {
      if (command !== "gh") return
      if (args[0] === "repo") return { stdout: "acme/widget" }
      return { stdout: JSON.stringify({ id: 7, node_id: "R_7" }) }
    })
    expect(result).toEqual({
      id: "7", nodeId: "R_7", owner: "acme", name: "widget",
      fullName: "acme/widget", installationId: undefined
    })
  })

  it("surfaces missing resources so the App fallback can retry them", async () => {
    const result = await run(Effect.either(GitHubCli.issueView("/repo", 404)), (command, args) =>
      command === "gh" && args[0] === "issue"
        ? { exitCode: 1, stderr: "HTTP 404: Not Found" }
        : undefined
    )
    expect(result).toMatchObject({ _tag: "Left", left: { reason: "not-found" } })
  })

  it("resolves worktree PRs from one shared open-PR list per clone", async () => {
    resetGhRateGate()
    const calls: string[] = []
    const handler: Parameters<typeof fakeCommandExecutor>[0] = (command, args) => {
      calls.push(`${command} ${args.join(" ")}`)
      if (command === "git" && args.includes("--abbrev-ref")) return { exitCode: 0, stdout: "feature\n" }
      if (command === "git") return { exitCode: 0, stdout: "/repo/.git\n" }
      return { exitCode: 0, stdout: JSON.stringify([
        { number: 7, headRefName: "feature", isCrossRepository: false },
        { number: 8, headRefName: "fork-feature", isCrossRepository: true }
      ]) }
    }
    await expect(run(GitHubCli.prForWorktree("/wt-a"), handler)).resolves.toBe(7)
    await expect(run(GitHubCli.prForWorktree("/wt-b"), handler)).resolves.toBe(7)
    expect(calls.filter((call) => call.startsWith("gh "))).toEqual([
      "gh pr list --state open --author @me --limit 200 --json number,headRefName,isCrossRepository"
    ])
  })

  it("returns null with no open PR for the branch and surfaces gh failures", async () => {
    resetGhRateGate()
    const git = (command: string, args: ReadonlyArray<string>) =>
      command === "git" ? { exitCode: 0, stdout: args.includes("--abbrev-ref") ? "feature" : "/repo/.git" } : undefined
    await expect(run(GitHubCli.prForWorktree("/repo"), (command, args) =>
      git(command, args) ?? { exitCode: 0, stdout: "[]" }
    )).resolves.toBeNull()
    resetGhRateGate()
    await expect(run(GitHubCli.prForWorktree("/repo"), (command, args) =>
      git(command, args) ?? { exitCode: 1, stderr: "network unavailable" }
    )).rejects.toMatchObject({ message: "network unavailable" })
  })
})
