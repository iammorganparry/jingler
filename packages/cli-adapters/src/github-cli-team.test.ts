import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
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
  if (args[1] === "rate_limit") return { stdout: JSON.stringify({ resources: { search: { remaining: 0, reset: Math.floor(Date.now() / 1000) + 60 } } }) }
  if (args[1]?.endsWith(`/memberships/${account.login}`)) return { stdout: '{"state":"active"}' }
  if (args[1] === "orgs/acme/repos") return { stdout: JSON.stringify([Array.from({ length: orgRepos }, (_, id) => ({ full_name: `acme/repo${id}` }))]) }
  return request(command, args, stdin, env)
}

afterEach(() => vi.restoreAllMocks())

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

  it("partitions oversized reviews across every org repo while retaining the team-review condition", async () => {
    const queries: string[] = []
    const result = await run(GitHubCli.teamPrs(input), handler((_command, args) => {
      const query = args.find((arg) => arg.startsWith("q="))!
      queries.push(query)
      expect(query).toContain("team-review-requested:acme/platform")
      expect(query).not.toContain("org:acme")
      return search(query.includes("repo:acme/repo4000 ") ? [row(42, false, "acme/repo4000")] : [])
    }, undefined, 4001))
    expect(queries).toHaveLength(4001)
    expect(result.prs.map((pr) => pr.repository)).toEqual(["acme/repo4000"])
    expect(result.warnings).toEqual([])
  })

  it("partitions oversized authored queues without member × repo searches and filters unrelated authors", async () => {
    let searches = 0
    const result = await run(GitHubCli.teamPrs({ ...input, queue: "authored" }), handler((_command, args) => {
      if (args[1]?.endsWith("/members")) return { stdout: '[[{"login":"member"},{"login":"other-member"}]]' }
      const query = args.find((arg) => arg.startsWith("q="))!
      searches++
      expect(query).not.toContain("org:acme")
      return search(query.includes("repo:acme/repo4000 ") ? [
        { ...row(42, false, "acme/repo4000"), user: { login: "member" } },
        { ...row(43, false, "acme/repo4000"), user: { login: "outsider" } },
      ] : [])
    }, undefined, 4001))
    expect(searches).toBe(4001)
    expect(result.prs.map((pr) => pr.number)).toEqual([42])
    expect(result.warnings).toEqual([])
  })

  it("retains a successful oversized first page when its first split hits the quota", async () => {
    let searches = 0
    const result = await run(GitHubCli.teamPrs(input), handler(() => {
      searches++
      return searches === 1 ? search(Array.from({ length: 100 }, (_, i) => row(i + 1)), 1001)
        : { exitCode: 1, stderr: "HTTP 403 rate limit exceeded" }
    }))
    expect(searches).toBe(2)
    expect(result.prs).toHaveLength(100)
    expect(result.warnings.join(" ")).toContain("unfinished")
  })

  it.each(["authored", "repositories"] as const)("resumes %s work first after successive quota windows, then revalidates completed queries", async (queue) => {
    let now = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let allowance = 2
    const successful: string[] = []
    const attempted: string[] = []
    let searches = 0
    const results = await run(Effect.gen(function* () {
      const first = yield* GitHubCli.teamPrs({ ...input, queue, refresh: true })
      const waiting = yield* GitHubCli.teamPrs({ ...input, queue, refresh: true })
      now += 70_000
      allowance = 2
      const second = yield* GitHubCli.teamPrs({ ...input, queue, refresh: true })
      now += 70_000
      allowance = 2
      const last = yield* GitHubCli.teamPrs({ ...input, queue, refresh: true })
      return [first, waiting, second, last]
    }), handler((_command, args) => {
      if (args[1]?.endsWith("/members")) return { stdout: JSON.stringify([[1, 2, 3, 4, 5].map((i) => ({ login: `member${i}` }))]) }
      if (args[1]?.endsWith("/repos")) return { stdout: JSON.stringify([[1, 2, 3, 4, 5].map((i) => ({ full_name: `acme/repo${i}` }))]) }
      searches++
      const query = args.find((arg) => arg.startsWith("q="))!
      const id = Number(/(?:member|repo)(\d+)/.exec(query)![1])
      attempted.push(String(id))
      if (allowance-- <= 0) return { exitCode: 1, stderr: "HTTP 403 rate limit exceeded" }
      successful.push(String(id))
      return search([row(id)])
    }))
    expect(successful).toEqual(["1", "2", "3", "4", "5", "1"])
    expect(attempted).toEqual(["1", "2", "3", "3", "4", "5", "5", "1", "2"])
    expect(searches).toBe(9)
    expect(results.map((result) => result.prs.length)).toEqual([2, 2, 4, 5])
    expect(results[2]!.warnings.join(" ")).toContain("unfinished")
    expect(results[3]!.warnings.join(" ")).toContain("unfinished")
  })

  it("revalidates completed queries behind unfinished work and retires historical rows only when fresh work completes", async () => {
    let round = 0
    const order: string[] = []
    const results = await run(Effect.gen(function* () {
      const values = []
      for (round = 0; round < 3; round++) values.push(yield* GitHubCli.teamPrs({ ...input, queue: "repositories", refresh: true }))
      return values
    }), handler((_command, args) => {
      if (args[1]?.endsWith("/repos")) return { stdout: '[[{"full_name":"acme/repo1"},{"full_name":"acme/repo2"}]]' }
      const id = /repo:(acme\/repo\d)/.exec(args.find((arg) => arg.startsWith("q="))!)![1]!
      order.push(`${round}/${id}`)
      if (id === "acme/repo2") return search([row(3)], 1, true)
      return round === 0 ? search([row(1)]) : search([row(2)], 1, round === 1)
    }))
    expect(order).toEqual(["0/acme/repo1", "0/acme/repo2", "1/acme/repo2", "1/acme/repo1", "2/acme/repo2", "2/acme/repo1"])
    expect(results.map((result) => result.prs.map((pr) => pr.number).sort())).toEqual([[1, 3], [1, 2, 3], [2, 3]])
    expect(results.every((result) => result.warnings.join(" ").includes("unfinished"))).toBe(true)
  })

  it("counts only the current recovery attempt, retaining partial history until it is complete", async () => {
    let calls = 0
    const results = await run(Effect.gen(function* () {
      const values = []
      for (let round = 0; round < 3; round++) values.push(yield* GitHubCli.teamPrs({ ...input, refresh: true }))
      return values
    }), handler(() => search(++calls === 1 ? [row(1)] : calls === 2 ? [row(2)] : [row(2), row(3)], 2)))
    expect(results.map((result) => result.prs.map((pr) => pr.number).sort())).toEqual([[1], [1, 2], [2, 3]])
    expect(results[1]!.warnings.join(" ")).toContain("fewer PRs")
    expect(results[2]!.warnings).toEqual([])
    expect(calls).toBe(3)
  })

  it("releases completed queue PR maps but retains unfinished progress until confirmed membership removal", async () => {
    const key = "1/acme/platform/authored"
    const cacheKey = "1/orgs/acme/teams/platform/members"
    let cached!: Map<string, unknown>
    let retained!: Map<string, unknown>
    const set = Map.prototype.set
    vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, name, value) {
      if (name === key) retained = this as Map<string, unknown>
      if (name === cacheKey) cached = this as Map<string, unknown>
      return set.call(this, name, value)
    })
    let partial = false
    let discoveryFails = true
    const results = await run(Effect.gen(function* () {
      const first = yield* GitHubCli.teamPrs({ ...input, queue: "authored" })
      expect(retained.has(key)).toBe(false)
      partial = true
      const second = yield* GitHubCli.teamPrs({ ...input, queue: "authored" })
      expect(retained.has(key)).toBe(true)
      expect(cached.has(cacheKey)).toBe(true)
      expect((yield* GitHubCli.teams().pipe(Effect.either))._tag).toBe("Left")
      expect(retained.has(key)).toBe(true)
      expect(cached.has(cacheKey)).toBe(true)
      discoveryFails = false
      yield* GitHubCli.teams()
      expect(retained.has(key)).toBe(false)
      expect(cached.has(cacheKey)).toBe(false)
      return [first, second]
    }), handler((_command, args) => {
      if (args[1] === "user/teams") return discoveryFails ? { exitCode: 1, stderr: "HTTP 403 SSO required" } : { stdout: "[[]]" }
      if (args[1]?.endsWith("/members")) return { stdout: '[[{"login":"teammate"}]]' }
      return search([row(42)], 1, partial)
    }))
    expect(results.map((result) => result.prs.length)).toEqual([1, 1])
    expect(results[1]!.warnings.join(" ")).toContain("unfinished")
  })

  it("resumes inside a paginated query without re-fetching successful pages", async () => {
    let now = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let allowance = 2
    const pages: number[] = []
    const results = await run(Effect.gen(function* () {
      const first = yield* GitHubCli.teamPrs(input)
      now += 70_000
      allowance = 2
      const second = yield* GitHubCli.teamPrs({ ...input, refresh: true })
      return [first, second]
    }), handler((_command, args) => {
      const page = Number(args.find((arg) => arg.startsWith("page="))!.slice(5))
      pages.push(page)
      if (allowance-- <= 0) return { exitCode: 1, stderr: "HTTP 403 rate limit exceeded" }
      return search(Array.from({ length: page === 4 ? 1 : 100 }, (_, i) => row((page - 1) * 100 + i + 1)), 301)
    }))
    expect(pages).toEqual([1, 2, 3, 3, 4])
    expect(results[0]!.prs).toHaveLength(200)
    expect(results[1]!.prs).toHaveLength(301)
    expect(results[1]!.warnings).toEqual([])
  })

  it("re-filters retained oversized authored rows when membership changes between quota rounds", async () => {
    let now = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let member = "old-member"
    let allowance = 1
    const results = await run(Effect.gen(function* () {
      const first = yield* GitHubCli.teamPrs({ ...input, queue: "authored", refresh: true })
      now += 70_000
      member = "new-member"
      allowance = 5000
      const second = yield* GitHubCli.teamPrs({ ...input, queue: "authored", refresh: true })
      return [first, second]
    }), handler((_command, args) => {
      if (args[1]?.endsWith("/members")) return { stdout: JSON.stringify([[{ login: member }]]) }
      if (allowance-- <= 0) return { exitCode: 1, stderr: "HTTP 403 rate limit exceeded" }
      const q = args.find((arg) => arg.startsWith("q="))!
      if (q.includes("repo:acme/repo0 ")) return search([{ ...row(42, false, "acme/repo0"), user: { login: "old-member" } }])
      if (q.includes("repo:acme/repo4000 ")) return search([{ ...row(43, false, "acme/repo4000"), user: { login: "new-member" } }])
      return search([])
    }, undefined, 4001))
    expect(results[0]!.prs.map((pr) => pr.number)).toEqual([42])
    expect(results[1]!.prs.map((pr) => pr.number)).toEqual([43])
    expect(results[1]!.warnings).toEqual([])
  })

  it.each(["reviews", "authored"] as const)("preserves usable %s searches when org scope metadata is unavailable", async (queue) => {
    const base = handler((_command, args) => {
      if (args[1]?.endsWith("/members")) return { stdout: '[[{"login":"member"}]]' }
      expect(args.find((arg) => arg.startsWith("q="))).toContain("org:acme")
      return search([row(42)])
    })
    const result = await run(GitHubCli.teamPrs({ ...input, queue }), (command, args, stdin, env) =>
      args[1] === "orgs/acme/repos" ? { exitCode: 1, stderr: "HTTP 403 forbidden metadata" } : base(command, args, stdin, env))
    expect(result.prs.map((pr) => pr.number)).toEqual([42])
    expect(result.warnings.join(" ")).toContain("Could not verify GitHub's repository search scope")
    expect(result.warnings.join(" ")).toContain("may be incomplete")
  })

  it("clears superseded range counts when incomplete-count recovery spans different seconds", async () => {
    let now = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let searches = 0
    const results = await run(Effect.gen(function* () {
      const first = yield* GitHubCli.teamPrs(input)
      now += 5_000
      const second = yield* GitHubCli.teamPrs({ ...input, refresh: true })
      now += 5_000
      const third = yield* GitHubCli.teamPrs({ ...input, refresh: true })
      return [first, second, third]
    }), handler(() => search(Array.from({ length: ++searches }, (_, i) => row(i + 1)), 3)))
    expect(results.map((result) => result.prs.length)).toEqual([1, 2, 3])
    expect(results[0]!.warnings.join(" ")).toContain("fewer PRs")
    expect(results[1]!.warnings.join(" ")).toContain("fewer PRs")
    expect(results[2]!.warnings).toEqual([])
    expect(searches).toBe(3)
  })

  it("stops the entire queue and holds a fallback cooldown when the reported quota reset has elapsed", async () => {
    let now = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let searches = 0
    const base = handler((_command, args) => {
      if (args[1]?.endsWith("/members")) return { stdout: '[[{"login":"one"},{"login":"two"},{"login":"three"}]]' }
      searches++
      return { exitCode: 1, stderr: "HTTP 403 rate limit exceeded" }
    })
    const results = await run(Effect.gen(function* () {
      const first = yield* GitHubCli.teamPrs({ ...input, queue: "authored" })
      const waiting = yield* GitHubCli.teamPrs({ ...input, queue: "authored", refresh: true })
      return [first, waiting]
    }), (command, args, stdin, env) => {
      if (args[1] === "rate_limit") {
        const reset = Math.floor(now / 1000) + 1
        now += 10_000
        return { stdout: JSON.stringify({ resources: { search: { remaining: 0, reset } } }) }
      }
      return base(command, args, stdin, env)
    })
    expect(searches).toBe(1)
    expect(results.every((result) => result.warnings.join(" ").includes("rate limit"))).toBe(true)
  })

  it("resumes split ranges across quota rounds without re-fetching successful ancestors", async () => {
    let now = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const dataset = Array.from({ length: 1001 }, (_, i) => ({ ...row(i + 1), created_at: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString() }))
    let allowance = 5
    const successful = new Set<string>()
    const result = await run(Effect.gen(function* () {
      let result = yield* GitHubCli.teamPrs(input)
      for (let round = 0; result.warnings.length > 0 && round < 10; round++) {
        now += 70_000
        allowance = 5
        result = yield* GitHubCli.teamPrs({ ...input, refresh: true })
      }
      return result
    }), handler((_command, args) => {
      const query = args.find((arg) => arg.startsWith("q="))!
      const page = Number(args.find((arg) => arg.startsWith("page="))!.slice(5))
      if (allowance-- <= 0) return { exitCode: 1, stderr: "HTTP 403 rate limit exceeded" }
      const signature = `${query}/${page}`
      expect(successful.has(signature)).toBe(false)
      successful.add(signature)
      const range = /created:(\S+)\.\.(\S+)/.exec(query)!
      const matching = dataset.filter((pr) => Date.parse(pr.created_at) >= Date.parse(range[1]!) && Date.parse(pr.created_at) <= Date.parse(range[2]!))
      return search(matching.slice((page - 1) * 100, page * 100), matching.length)
    }))
    expect(result.prs).toHaveLength(1001)
    expect(result.warnings).toEqual([])
  })

  it.each(["authored", "repositories"] as const)("keeps completed pages and advances later %s queries despite partial page one", async (queue) => {
    let now = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let allowance = 2
    const successful: string[] = []
    const results = await run(Effect.gen(function* () {
      const values = []
      for (let round = 0; round < 3; round++) {
        allowance = 2
        values.push(yield* GitHubCli.teamPrs({ ...input, queue, refresh: true }))
        now += 70_000
      }
      return values
    }), handler((_command, args) => {
      if (args[1]?.endsWith("/members")) return { stdout: '[[{"login":"member1"},{"login":"member2"}]]' }
      if (args[1]?.endsWith("/repos")) return { stdout: '[[{"full_name":"acme/repo1"},{"full_name":"acme/repo2"}]]' }
      if (allowance-- <= 0) return { exitCode: 1, stderr: "HTTP 403 rate limit exceeded" }
      const query = args.find((arg) => arg.startsWith("q="))!
      const id = Number(/(?:member|repo)(\d+)/.exec(query)![1])
      const page = Number(args.find((arg) => arg.startsWith("page="))!.slice(5))
      successful.push(`${id}/${page}`)
      if (id === 2) return search([row(999)])
      return search(Array.from({ length: page === 3 ? 1 : 100 }, (_, i) => row((page - 1) * 100 + i + 1)), 201, page === 1)
    }))
    expect(results.map((result) => result.prs.length)).toEqual([200, 202, 202])
    expect(successful.filter((page) => page === "1/2")).toHaveLength(1)
    expect(successful.filter((page) => page === "1/3")).toHaveLength(1)
    expect(results[1]!.prs.some((pr) => pr.number === 999)).toBe(true)
    expect(results[2]!.warnings.join(" ")).toContain("unfinished")
  })

  it.each([3, 5])("does not starve later members when %i queries stay incomplete in every quota window", async (count) => {
    let now = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let allowance = 2
    const results = await run(Effect.gen(function* () {
      const values = []
      for (let round = 0; round < 3; round++) {
        allowance = 2
        values.push(yield* GitHubCli.teamPrs({ ...input, queue: "authored", refresh: true }))
        now += 70_000
      }
      return values
    }), handler((_command, args) => {
      if (args[1]?.endsWith("/members")) return { stdout: JSON.stringify([Array.from({ length: count }, (_, i) => ({ login: `member${i + 1}` }))]) }
      if (allowance-- <= 0) return { exitCode: 1, stderr: "HTTP 403 rate limit exceeded" }
      const query = args.find((arg) => arg.startsWith("q="))!
      const id = Number(/member(\d+)/.exec(query)![1])
      return search([row(id)], 1, true)
    }))
    expect(results.map((result) => result.prs.length)).toEqual([2, Math.min(4, count), count])
    expect(results[2]!.prs.map((pr) => pr.number).sort()).toEqual(Array.from({ length: count }, (_, i) => i + 1))
    expect(results[2]!.warnings.join(" ")).toContain("unfinished")
  })

  it("advances page three when pages one and two stay incomplete across two-request quota windows", async () => {
    let now = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let allowance = 2
    const successful: number[] = []
    const results = await run(Effect.gen(function* () {
      const values = []
      for (let round = 0; round < 3; round++) {
        allowance = 2
        values.push(yield* GitHubCli.teamPrs({ ...input, refresh: true }))
        now += 70_000
      }
      return values
    }), handler((_command, args) => {
      if (allowance-- <= 0) return { exitCode: 1, stderr: "HTTP 403 rate limit exceeded" }
      const page = Number(args.find((arg) => arg.startsWith("page="))!.slice(5))
      successful.push(page)
      return search(Array.from({ length: page === 3 ? 1 : 100 }, (_, i) => row((page - 1) * 100 + i + 1)), 201, page < 3)
    }))
    expect(results.map((result) => result.prs.length)).toEqual([200, 201, 201])
    expect(successful.filter((page) => page === 3)).toHaveLength(1)
    expect(results[2]!.warnings.join(" ")).toContain("unfinished")
  })

  it("keeps a retained same-second ceiling warning after another repository finishes on refresh", async () => {
    let now = 0
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let allowance = 10
    const results = await run(Effect.gen(function* () {
      const first = yield* GitHubCli.teamPrs({ ...input, queue: "repositories", refresh: true })
      now += 70_000
      allowance = 30
      const second = yield* GitHubCli.teamPrs({ ...input, queue: "repositories", refresh: true })
      return [first, second]
    }), handler((_command, args) => {
      if (args[1]?.endsWith("/repos")) return { stdout: '[[{"full_name":"acme/repo1"},{"full_name":"acme/repo2"}]]' }
      if (allowance-- <= 0) return { exitCode: 1, stderr: "HTTP 403 rate limit exceeded" }
      const query = args.find((arg) => arg.startsWith("q="))!
      if (query.includes("repo:acme/repo2 ")) return search([row(1001, false, "acme/repo2")])
      // All 1001 rows were created at epoch second zero, not in every split.
      const range = /created:(\S+)\.\.(\S+)/.exec(query)!
      if (Date.parse(range[1]!) > 0) return search([])
      const page = Number(args.find((arg) => arg.startsWith("page="))!.slice(5))
      return search(Array.from({ length: 100 }, (_, i) => row((page - 1) * 100 + i + 1, false, "acme/repo1")), 1001)
    }))
    expect(results.map((result) => result.prs.length)).toEqual([1000, 1001])
    expect(results[0]!.warnings.join(" ")).toContain("same creation second")
    expect(results[1]!.warnings.join(" ")).toContain("same creation second")
    expect(results[1]!.warnings.join(" ")).not.toContain("unfinished")
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
