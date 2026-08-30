import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { GitHubCli } from "./github-cli.js"
import { fakeCommandExecutor } from "./test-support.js"

const run = <A>(effect: Effect.Effect<A, unknown, unknown>, handler: Parameters<typeof fakeCommandExecutor>[0]): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(GitHubCli.Default, fakeCommandExecutor(handler))) as never)) as Promise<A>

describe("GitHubCli", () => {
  it("detects an authenticated CLI", async () => {
    await expect(run(GitHubCli.available(), (command, args) => {
      if (command === "which") return { stdout: "/usr/local/bin/gh\n" }
      if (command === "gh" && args[0] === "auth") return { stdout: "github.com\n" }
      return
    })).resolves.toBe(true)
  })

  it("paginates the inbox and preserves viewer relationships", async () => {
    const result = await run(GitHubCli.inbox(), (command, args) => {
      if (command !== "gh" || args[0] !== "api") return
      expect(args).toEqual(expect.arrayContaining(["--paginate", "--slurp"]))
      expect(args.join(" ")).toEqual(expect.stringContaining("viewer{login}"))
      expect(args.join(" ")).toEqual(expect.stringContaining("after:$endCursor"))
      expect(args.join(" ")).toEqual(expect.stringContaining("pageInfo{hasNextPage endCursor}"))
      expect(args.join(" ")).toEqual(expect.stringContaining("requestedReviewer{... on User{login}}"))
      const pull = (number: number) => ({
        number,
        repository: { nameWithOwner: "acme/widget" },
        title: `PR ${number}`,
        url: `https://github.com/acme/widget/pull/${number}`,
        assignees: { nodes: number === 101 ? [{ login: "OCTOCAT" }] : [] },
        reviewRequests: { nodes: number === 101
          ? [{ requestedReviewer: { login: "octocat" } }]
          : [] }
      })
      return { stdout: JSON.stringify([
        { data: { viewer: { login: "octocat" }, search: { nodes: Array.from({ length: 100 }, (_, index) => pull(index + 1)) } } },
        { data: { viewer: { login: "octocat" }, search: { nodes: [pull(101)] } } }
      ]) }
    })

    expect(result).toHaveLength(101)
    expect(result[100]).toMatchObject({ assignedToViewer: true, reviewRequestedFromViewer: true })
  })

  it("loads a PR and inline review threads through gh", async () => {
    const commands: Array<ReadonlyArray<string>> = []
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
      if (args.join(" ").includes("commits(first:100")) {
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
      if (args[0] === "api") return { stdout: JSON.stringify([{
        data: { repository: { pullRequest: { reviewThreads: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null }
        } } } }
      }]) }
      return
    })

    expect(result).toMatchObject({ number: 42, title: "CLI first", commits: 2 })
    expect(result.commitItems).toMatchObject([
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
    expect(commands.map((args) => args[0])).toEqual(["pr", "repo", "api", "api"])
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

    expect(result.reviewThreads.map((thread) => thread.id)).toEqual(["t1", "t2"])
    expect(result.reviewThreads[0]?.comments.map((comment) => comment.id)).toEqual(["c1", "c2"])
  })

  it("propagates review-thread failures instead of presenting an empty review", async () => {
    await expect(run(GitHubCli.prViewBySlug("acme/widget", 42), (command, args) => {
      if (command !== "gh") return
      if (args[0] === "pr") return { stdout: JSON.stringify({ state: "OPEN", number: 42 }) }
      if (args[0] === "api") return { exitCode: 1, stderr: "GraphQL rate limit reached" }
      return
    })).rejects.toThrow("GraphQL rate limit reached")
  })

  it("returns null only for an explicit no-PR result", async () => {
    await expect(run(GitHubCli.prForWorktree("/repo"), (command, args) =>
      command === "gh" && args[0] === "pr"
        ? { exitCode: 1, stderr: "no pull requests found for branch feature" }
        : undefined
    )).resolves.toBeNull()
    await expect(run(GitHubCli.prForWorktree("/repo"), (command, args) =>
      command === "gh" && args[0] === "pr"
        ? { exitCode: 1, stderr: "network unavailable" }
        : undefined
    )).rejects.toMatchObject({ message: "network unavailable" })
  })
})
