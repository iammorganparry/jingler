import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { GitHubCli } from "./github-cli.js"
import { fakeCommandExecutor, type FakeCommandHandler } from "./test-support.js"

const run = <A>(effect: Effect.Effect<A, unknown, unknown>, handler: FakeCommandHandler): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(GitHubCli.Default, fakeCommandExecutor(handler))) as never)) as Promise<A>

const row = (number: number, draft = false, repository = "acme/widget") => ({
  number, title: `Team PR ${number}`, state: "open", draft,
  html_url: `https://github.com/${repository}/pull/${number}`,
  updated_at: `2026-01-${String(number % 27 + 1).padStart(2, "0")}T00:00:00Z`,
  user: { login: "teammate" }, labels: [], comments: 2,
})
const search = (items: unknown[], total = items.length, incomplete = false) => ({
  stdout: JSON.stringify({ total_count: total, incomplete_results: incomplete, items }),
})
const input = { accountId: "1", organization: "acme", teamSlug: "platform", queue: "reviews" as const, refresh: false }

const handler = (request: FakeCommandHandler, account = { id: 1, login: "octocat" }, orgRepos = 1): FakeCommandHandler => (command, args, stdin, env) => {
  if (command !== "gh") return
  if (args[0] === "auth" && args[1] === "token") {
    expect(args).toEqual(["auth", "token", "--hostname", "github.com"])
    return { stdout: "scripted-private-credential" }
  }
  // Assert only a boolean so failing tests do not print credentials.
  expect(env.get("GH_TOKEN") === "scripted-private-credential").toBe(true)
  expect(env.get("GH_HOST")).toBe("github.com")
  expect(env.get("GH_DEBUG")).toBe("")
  if (args[0] === "api" && args[1] === "user") return { stdout: JSON.stringify(account) }
  if (args[1]?.endsWith(`/memberships/${account.login}`)) return { stdout: '{"state":"active"}' }
  if (args[1] === "orgs/acme/repos") return { stdout: JSON.stringify([Array.from({ length: orgRepos }, (_, id) => ({ full_name: `acme/repo${id}` }))]) }
  return request(command, args, stdin, env)
}

describe("GitHubCli team inbox", () => {
  it("discovers paginated memberships and ignores enterprise-level teams", async () => {
    const result = await run(GitHubCli.teams(), handler((_command, args) => {
      expect(args).toEqual(expect.arrayContaining(["user/teams", "--hostname", "github.com", "--paginate", "--slurp"]))
      return { stdout: JSON.stringify([
        [{ id: 7, organization: { login: "acme" }, slug: "platform", name: "Platform" }],
        [{ id: 8, organization: { login: "other" }, slug: "web", name: "Web" }, { type: "enterprise" }],
      ]) }
    }))
    expect(result).toEqual({ account: { id: "1", login: "octocat" }, teams: [
      { id: "7", organization: "acme", slug: "platform", name: "Platform" },
      { id: "8", organization: "other", slug: "web", name: "Web" },
    ] })
  })

  it("paginates requested-review results, preserves drafts and uses the exact team qualifier", async () => {
    const pages: string[] = []
    const result = await run(GitHubCli.teamPrs(input), handler((_command, args) => {
      expect(args[1]).toBe("search/issues")
      expect(args).toContain("--hostname")
      const query = args.find((arg) => arg.startsWith("q="))!
      expect(query).toContain("is:pr is:open org:acme team-review-requested:acme/platform")
      expect(query).not.toContain("involves:@me")
      pages.push(args.find((arg) => arg.startsWith("page="))!)
      return args.includes("page=1")
        ? search(Array.from({ length: 100 }, (_, index) => row(index + 1)), 101)
        : search([row(101, true)], 101)
    }))
    expect(pages).toEqual(["page=1", "page=2"])
    expect(result.prs).toHaveLength(101)
    expect(result.prs.find((pr) => pr.number === 101)?.isDraft).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it("queries paginated current members (including API child members) only within the owning org and deduplicates", async () => {
    const queries: string[] = []
    const result = await run(GitHubCli.teamPrs({ ...input, queue: "authored" }), handler((_command, args) => {
      if (args[1]?.endsWith("/members")) {
        expect(args).toEqual(expect.arrayContaining(["--paginate", "--slurp"]))
        return { stdout: JSON.stringify([[{ login: "parent" }], [{ login: "child", inherited: true }]]) }
      }
      queries.push(args.find((arg) => arg.startsWith("q="))!)
      return search([row(42)])
    }))
    expect(queries).toEqual(expect.arrayContaining([
      expect.stringContaining("org:acme author:parent"), expect.stringContaining("org:acme author:child"),
    ]))
    expect(result.prs).toHaveLength(1)
  })

  it("lists only accessible team repositories and preserves successful portions on access failure", async () => {
    const result = await run(GitHubCli.teamPrs({ ...input, queue: "repositories" }), handler((_command, args) => {
      if (args[1]?.endsWith("/repos")) return { stdout: '[[{"full_name":"acme/widget"}],[{"full_name":"acme/hidden"}]]' }
      const query = args.find((arg) => arg.startsWith("q="))!
      if (query.includes("repo:acme/hidden")) return { exitCode: 1, stderr: "HTTP 403 SAML SSO private-secret" }
      expect(query).toContain("repo:acme/widget")
      return search([row(42)])
    }))
    expect(result.prs).toHaveLength(1)
    expect(result.warnings[0]).toContain("SSO")
    expect(result.warnings.join(" ")).not.toContain("private-secret")
  })

  it("splits searches above 1000 into disjoint creation ranges instead of truncating", async () => {
    const queries: string[] = []
    const dataset = Array.from({ length: 1001 }, (_, index) => ({
      ...row(index + 1), created_at: new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString(),
    }))
    const result = await run(GitHubCli.teamPrs(input), handler((_command, args) => {
      const query = args.find((arg) => arg.startsWith("q="))!
      queries.push(query)
      const range = /created:(\S+)\.\.(\S+)/.exec(query)!
      const matching = dataset.filter((item) => Date.parse(item.created_at) >= Date.parse(range[1]!) && Date.parse(item.created_at) <= Date.parse(range[2]!))
      const page = Number(args.find((arg) => arg.startsWith("page="))!.slice(5))
      return search(matching.slice((page - 1) * 100, page * 100), matching.length)
    }))
    expect(queries.length).toBeGreaterThan(11)
    expect(result.prs).toHaveLength(1001)
    expect(new Set(result.prs.map((pr) => pr.number)).size).toBe(1001)
    expect(result.warnings).toEqual([])
  })

  it("marks incomplete results and stops new searches after rate limiting", async () => {
    let searches = 0
    const result = await run(GitHubCli.teamPrs({ ...input, queue: "authored" }), handler((_command, args) => {
      if (args[1]?.endsWith("/members")) return { stdout: '[[{"login":"one"},{"login":"two"},{"login":"three"}]]' }
      searches++
      if (searches === 1) return search([row(42)], 1, true)
      return { exitCode: 1, stderr: "HTTP 403 API rate limit exceeded; token=private-secret" }
    }))
    expect(searches).toBe(2)
    expect(result.prs).toHaveLength(1)
    expect(result.warnings.join(" ")).toMatch(/incomplete.*rate limit/s)
    expect(result.warnings.join(" ")).not.toContain("private-secret")
  })

  it("refreshes cached member discovery when explicitly requested", async () => {
    let discoveries = 0
    await run(Effect.gen(function* () {
      yield* GitHubCli.teamPrs({ ...input, queue: "authored" })
      yield* GitHubCli.teamPrs({ ...input, queue: "authored" })
      yield* GitHubCli.teamPrs({ ...input, queue: "authored", refresh: true })
    }), handler((_command, args) => {
      if (args[1]?.endsWith("/members")) { discoveries++; return { stdout: '[[{"login":"one"}]]' } }
      return search([])
    }))
    expect(discoveries).toBe(2)
  })

  it("isolates cached membership data across CLI accounts", async () => {
    let id = 1
    const discoveries: number[] = []
    const first = handler((_command, args) => {
      if (args[1]?.endsWith("/members")) { discoveries.push(id); return { stdout: `[[{"login":"member${id}"}]]` } }
      return search([])
    }, { get id() { return id }, login: "octocat" })
    await run(Effect.gen(function* () {
      yield* GitHubCli.teamPrs({ ...input, queue: "authored" })
      id = 2
      yield* GitHubCli.teamPrs({ ...input, accountId: "2", queue: "authored" })
      id = 1
      yield* GitHubCli.teamPrs({ ...input, queue: "authored" })
    }), first)
    expect(discoveries).toEqual([1, 2])
  })

  it("supports managed-user accounts and inherited managed-user authors", async () => {
    const result = await run(GitHubCli.teamPrs({ ...input, queue: "authored" }), handler((_command, args) => {
      if (args[1]?.endsWith("/members")) return { stdout: '[[{"login":"mona-cat_octo","inherited":true}]]' }
      expect(args.find((arg) => arg.startsWith("q="))).toContain("author:mona-cat_octo")
      return search([row(42)])
    }, { id: 1, login: "mona-cat_octo" }))
    expect(result.prs).toHaveLength(1)
    expect(result.warnings).toEqual([])
  })

  it("marks a broad queue partial above the independent 4000-repository scope limit", async () => {
    const result = await run(GitHubCli.teamPrs(input), handler(() => search([row(42)]), undefined, 4001))
    expect(result.prs).toHaveLength(1)
    expect(result.warnings.join(" ")).toContain("4,000-repository")
  })

  it("rejects an account switch before detail, mutation or pickup and never executes the PR command", async () => {
    const actions = [
      GitHubCli.teamPr({ accountId: "2", repository: "acme/widget", number: 42 }),
      GitHubCli.teamComment({ accountId: "2", repository: "acme/widget", number: 42, body: "hi" }),
      GitHubCli.teamClose({ accountId: "2", repository: "acme/widget", number: 42 }),
      GitHubCli.teamMerge({ accountId: "2", repository: "acme/widget", number: 42, method: "merge" }),
      GitHubCli.teamCheckout({ accountId: "2", repository: "acme/widget", number: 42 }),
    ]
    for (const action of actions) {
      let prCalls = 0
      await expect(run(action, handler(() => { prCalls++; return {} }))).rejects.toThrow("account changed")
      expect(prCalls).toBe(0)
    }
  })

  it("keeps mutations pinned to github.com and does not put credentials in argv/stdin", async () => {
    const actions = [
      GitHubCli.teamComment({ accountId: "1", repository: "acme/widget", number: 42, body: "Ship it" }),
      GitHubCli.teamClose({ accountId: "1", repository: "acme/widget", number: 42 }),
      GitHubCli.teamMerge({ accountId: "1", repository: "acme/widget", number: 42, method: "squash" }),
    ]
    const seen: string[] = []
    for (const action of actions) await run(action, handler((_command, args, stdin) => {
      expect(args).toContain("github.com/acme/widget")
      expect(args.join(" ").includes("scripted-private-credential")).toBe(false)
      expect(stdin.includes("scripted-private-credential")).toBe(false)
      seen.push(args[1]!)
      return {}
    }))
    expect(seen).toEqual(["comment", "close", "merge"])
  })

  it("pins successful detail and fork pickup to github.com and disables ambient fetch credentials", async () => {
    const commands: string[][] = []
    const cliHandler = handler((_command, args) => {
      commands.push([...args])
      if (args[0] === "pr") return { stdout: JSON.stringify({
        state: "OPEN", number: 42, title: "Fork", headRefName: "feature", headRefOid: "abc",
        headRepository: { nameWithOwner: "contributor_octo/widget" }, commits: [],
      }) }
      if (args[1]?.startsWith("repos/") && !args[1]?.endsWith("/files")) return { stdout: JSON.stringify({ id: 7, node_id: "R_7", clone_url: "https://github.com/contributor_octo/widget.git" }) }
      if (args[1]?.endsWith("/files")) return { stdout: "[[]]" }
      const field = args.join(" ").includes("commits(first:100") ? "commits" : "reviewThreads"
      return { stdout: JSON.stringify([{ data: { repository: { pullRequest: { [field]: { nodes: [], pageInfo: { hasNextPage: false } } } } } }]) }
    })
    const gitHandler: FakeCommandHandler = (command, args, stdin, env) => {
      if (command !== "git") return cliHandler(command, args, stdin, env)
      if (args.includes("ls-remote")) return { stdout: args[args.length - 1] }
      if (args.includes("config")) return { stdout: "http.https://github.com/.extraheader\ncredential.https://github.com.helper\nhttp.https://github.com/.followredirects" }
      expect(args).toContain("credential.https://github.com.helper=")
      expect(args).toContain("http.https://github.com/.extraheader=")
      expect(args).toContain("http.followRedirects=false")
      expect(args).toContain("http.https://github.com/.followredirects=false")
      expect(env.get("GIT_ALLOW_PROTOCOL")).toBe("https")
      expect(env.get("JINGLER_GIT_ASKPASS_GITHUB_ONLY")).toBe("1")
      expect(env.get("GH_TOKEN")).toBe("")
      expect(args.join(" ").includes("scripted-private-credential")).toBe(false)
      commands.push([...args])
      return {}
    }
    await run(Effect.gen(function* () {
      yield* GitHubCli.teamPr({ accountId: "1", repository: "acme/widget", number: 42 })
      const checkout = yield* GitHubCli.teamCheckout({ accountId: "1", repository: "acme/widget", number: 42 })
      yield* checkout.fetchBase("/repo", "main")
      yield* checkout.fetchHead("/worktree", "refs/remotes/jingler-pr-7/feature")
    }), gitHandler)
    expect(commands.filter((args) => args.includes("fetch")).map((args) => args[args.length - 2])).toEqual([
      "https://github.com/acme/widget.git", "https://github.com/contributor_octo/widget.git",
    ])
    expect(commands.filter((args) => args[0] === "pr").every((args) => args.includes("github.com/acme/widget"))).toBe(true)
  })

  it("rejects invalid discovery/input rather than silently returning empty teams", async () => {
    await expect(run(GitHubCli.teams(), handler(() => ({ stdout: '[{"not":"pages"}]' })))).rejects.toThrow("pagination")
    await expect(run(GitHubCli.teamPrs({ ...input, teamSlug: "../secret" }), handler(() => ({})))).rejects.toThrow("valid GitHub organization team")
    await expect(run(GitHubCli.teamPr({ accountId: "1", repository: "acme/widget?token=bad", number: 42 }), handler(() => ({})))).rejects.toThrow("valid GitHub pull request")
  })
})
