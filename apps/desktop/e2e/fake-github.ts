import type { GitHubAppConnectionStatus, GitHubAppInstallation } from "@jingler/core"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export interface FakeGitHubPr {
  readonly number: number
  readonly title: string
  readonly headRefName: string
  readonly baseRefName: string
  readonly author: { readonly login: string }
  readonly state?: string
  readonly isDraft?: boolean
  readonly additions?: number
  readonly deletions?: number
  readonly updatedAt?: string
  readonly body?: string
  readonly labels?: ReadonlyArray<{ readonly name: string; readonly color?: string }>
  readonly mergeStateStatus?: string
  readonly checks?: ReadonlyArray<{
    readonly name: string
    readonly conclusion?: string
    readonly status?: string
    readonly detailsUrl?: string
  }>
  readonly headRepository?: {
    readonly id?: number
    readonly fullName: string
    readonly cloneUrl?: string
    readonly sshUrl?: string | null
  }
}

export interface FakeGitHubIssue {
  readonly number: number
  readonly title: string
  readonly url?: string
  readonly body?: string
  readonly labels?: ReadonlyArray<{ readonly name: string; readonly color?: string }>
  readonly author: { readonly login: string }
  readonly assignees?: ReadonlyArray<{ readonly login: string }>
  readonly updatedAt?: string
}

export interface FakeGitHubOptions {
  readonly connected?: boolean
  readonly userLogin?: string
  readonly accountLogin?: string
  readonly repositorySelection?: "all" | "selected"
  readonly suspended?: boolean
  readonly prs?: ReadonlyArray<FakeGitHubPr>
  readonly issues?: ReadonlyArray<FakeGitHubIssue>
  readonly diff?: string
  /** Local checkout used as the API-resolved head remote in fork/session tests. */
  readonly cloneUrl?: string
  /** WebSocket relay origin returned by the short-lived desktop grant. */
  readonly relayUrl?: string
  readonly relayGrant?: string
}

export interface FakeGitHubServer {
  readonly url: string
  /** Sanitized request metadata: credentials and bodies are deliberately absent. */
  readonly requests: ReadonlyArray<{ method: string; path: string }>
  /** Semantic write operations for assertions such as selected merge method. */
  readonly operations: ReadonlyArray<string>
  readonly connect: () => void
  readonly setInstallation: (patch: Partial<GitHubAppInstallation>) => void
  /** Fail exactly the next matching mutation, then recover for retry/restart tests. */
  readonly failNext: (operation: "create-pr" | "update-pr") => void
  readonly status: () => GitHubAppConnectionStatus
  readonly publishedPr: () => { readonly number: number; readonly title: string; readonly body: string; readonly head: string; readonly base: string } | null
  readonly close: () => Promise<void>
}

const rateHeaders = {
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4999",
  "x-ratelimit-used": "1",
  "x-ratelimit-reset": "1893456000"
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...rateHeaders
  })
  res.end(JSON.stringify(body))
}

const text = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...rateHeaders
  })
  res.end(body)
}

const requestBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const page = <A>(rows: ReadonlyArray<A>, url: URL): ReadonlyArray<A> => {
  const pageNumber = Number(url.searchParams.get("page") ?? "1")
  const perPage = Number(url.searchParams.get("per_page") ?? "100")
  const start = Math.max(0, pageNumber - 1) * perPage
  return rows.slice(start, start + perPage)
}

/** Stateful, offline implementation of both desktop GitHub routes and the relay. */
export const startFakeGitHubServer = async (
  token: string,
  options: FakeGitHubOptions = {}
): Promise<FakeGitHubServer> => {
  let connected = options.connected ?? false
  let lastRefreshedAt: string | null = connected ? "2026-08-04T09:00:00.000Z" : null
  let installation: GitHubAppInstallation = {
    id: "101",
    account: {
      id: "201",
      login: options.accountLogin ?? "acme",
      type: "Organization",
      avatarUrl: null
    },
    repositorySelection: options.repositorySelection ?? "all",
    permissions: { contents: "write", pull_requests: "write", issues: "write" },
    status: options.suspended ? "suspended" : "active",
    suspendedAt: options.suspended ? "2026-08-04T08:00:00.000Z" : null
  }
  const prs = [...(options.prs ?? [])]
  const issues = [...(options.issues ?? [])]
  const requests: Array<{ method: string; path: string }> = []
  const operations: string[] = []
  const failures = new Set<"create-pr" | "update-pr">()
  const grant = options.relayGrant ?? "e2e-short-lived-github-grant"
  let publishedPr: { number: number; title: string; body: string; head: string; base: string } | null = null

  const status = (): GitHubAppConnectionStatus => ({
    enabled: true,
    connected,
    user: connected
      ? {
          id: "1",
          login: options.userLogin ?? "octocat",
          name: "Octo Cat",
          avatarUrl: null
        }
      : null,
    installations: connected ? [installation] : [],
    lastRefreshedAt
  })

  const pullJson = (pr: FakeGitHubPr) => {
    const upperState = (pr.state ?? "OPEN").toUpperCase()
    const merged = upperState === "MERGED"
    return {
      id: 10_000 + pr.number,
      node_id: `PR_${pr.number}`,
      number: pr.number,
      state: merged || upperState === "CLOSED" ? "closed" : "open",
      merged_at: merged ? pr.updatedAt ?? "2026-07-11T00:00:00Z" : null,
      draft: pr.isDraft ?? false,
      title: pr.title,
      body: pr.body ?? "",
      html_url: `https://github.com/acme/widget/pull/${pr.number}`,
      user: { login: pr.author.login, avatar_url: null },
      head: {
        ref: pr.headRefName,
        sha: `e2ehead${pr.number}`,
        repo: {
          id: pr.headRepository?.id ?? 301,
          full_name: pr.headRepository?.fullName ?? `${installation.account.login}/widget`,
          clone_url:
            pr.headRepository?.cloneUrl ??
            options.cloneUrl ??
            "https://github.com/acme/widget.git",
          ssh_url: pr.headRepository?.sshUrl ?? null
        }
      },
      base: { ref: pr.baseRefName },
      created_at: pr.updatedAt ?? "2026-07-11T00:00:00Z",
      updated_at: pr.updatedAt ?? "2026-07-11T00:00:00Z",
      commits: 1,
      changed_files: 1,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      labels: (pr.labels ?? []).map((label) => ({
        name: label.name,
        color: label.color ?? "cccccc"
      })),
      mergeable: pr.mergeStateStatus === "DIRTY" ? false : true,
      merge_state_status: pr.mergeStateStatus ?? "CLEAN"
    }
  }

  const issueJson = (issue: FakeGitHubIssue) => ({
    id: 20_000 + issue.number,
    number: issue.number,
    title: issue.title,
    html_url: issue.url ?? `https://github.com/acme/widget/issues/${issue.number}`,
    state: "open",
    body: issue.body ?? "",
    user: { login: issue.author.login, avatar_url: null },
    assignees: (issue.assignees ?? []).map((assignee) => ({
      login: assignee.login,
      avatar_url: null
    })),
    labels: (issue.labels ?? []).map((label) => ({
      name: label.name,
      color: label.color ?? "cccccc"
    })),
    created_at: issue.updatedAt ?? "2026-07-11T00:00:00Z",
    updated_at: issue.updatedAt ?? "2026-07-11T00:00:00Z"
  })

  let server!: Server
  const url = await new Promise<string>((resolve, reject) => {
    server = createServer(async (req, res) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1")
      const method = req.method ?? "GET"
      requests.push({ method, path: requestUrl.pathname })

      if (requestUrl.pathname === "/browser/install") {
        res.writeHead(200, { "content-type": "text/html" })
        res.end("<!doctype html><title>Fake GitHub App</title><p>Installation ready.</p>")
        return
      }

      if (requestUrl.pathname.startsWith("/api/github/")) {
        if (req.headers.authorization !== `Bearer ${token}`) {
          json(res, 401, { error: "Authentication required" })
          return
        }
        if (requestUrl.pathname === "/api/github/status" && method === "GET") {
          json(res, 200, status())
          return
        }
        if (requestUrl.pathname === "/api/github/install" && method === "GET") {
          const address = server.address() as AddressInfo
          json(res, 200, {
            url: `http://127.0.0.1:${address.port}/browser/install`,
            expiresAt: "2099-01-01T00:00:00.000Z"
          })
          return
        }
        if (requestUrl.pathname === "/api/github/refresh" && method === "POST") {
          lastRefreshedAt = new Date(
            Date.parse(lastRefreshedAt ?? "2026-08-04T09:00:00.000Z") + 1_000
          ).toISOString()
          json(res, 200, status())
          return
        }
        if (requestUrl.pathname === "/api/github/disconnect" && method === "POST") {
          connected = false
          lastRefreshedAt = null
          res.writeHead(204, { "cache-control": "no-store" }).end()
          return
        }
        if (requestUrl.pathname === "/api/github/desktop-grant" && method === "POST") {
          const body = await requestBody(req)
          if (!connected || installation.status === "suspended") {
            json(res, 403, { error: "Active installation required" })
            return
          }
          const installationId = String(body.installationId ?? "")
          if (installationId !== installation.id) {
            json(res, 403, { error: "Installation is not accessible" })
            return
          }
          json(res, 200, {
            relayUrl:
              options.relayUrl ?? `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            grant,
            claims: {
              version: 1,
              issuer: "jingler",
              audience: "jingler-github-relay",
              subject: "e2e-user",
              installationId,
              issuedAt: 1_786_000_000,
              expiresAt: 4_070_908_800,
              grantId: "e2e-grant-id"
            }
          })
          return
        }
        if (requestUrl.pathname === "/api/github/installation-credentials" && method === "POST") {
          const body = await requestBody(req)
          const installationId = String(body.installationId ?? "")
          if (!connected || installation.status === "suspended" || installationId !== installation.id) {
            json(res, 403, { error: "Active accessible installation required" })
            return
          }
          json(res, 200, {
            token: grant,
            installationId,
            expiresAt: "2099-01-01T00:00:00.000Z"
          })
          return
        }
        json(res, 404, { error: "Not found" })
        return
      }

      if (req.headers.authorization !== `Bearer ${grant}`) {
        json(res, 401, { message: "Bad credentials" })
        return
      }
      if (!connected) {
        json(res, 403, { message: "Installation disconnected" })
        return
      }
      if (installation.status === "suspended") {
        json(res, 403, { message: "Installation suspended" })
        return
      }

      if (requestUrl.pathname === "/user" && method === "GET") {
        json(res, 200, { id: 1, login: options.userLogin ?? "octocat" })
        return
      }
      if (requestUrl.pathname === "/graphql" && method === "POST") {
        const body = await requestBody(req)
        const query = String(body.query ?? "")
        if (query.includes("markPullRequestReadyForReview")) operations.push("pr ready")
        if (query.includes("resolveReviewThread")) operations.push("review thread resolve")
        if (query.includes("unresolveReviewThread")) operations.push("review thread unresolve")
        if (query.includes("reviewThreads")) {
          json(res, 200, {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: []
                  }
                }
              }
            }
          })
          return
        }
        json(res, 200, { data: {} })
        return
      }

      const repositoryMatch = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(requestUrl.pathname)
      if (!repositoryMatch) {
        json(res, 404, { message: "Not found" })
        return
      }
      const owner = decodeURIComponent(repositoryMatch[1]!)
      const repo = decodeURIComponent(repositoryMatch[2]!)
      const suffix = repositoryMatch[3] ?? ""
      if (owner.toLowerCase() !== installation.account.login.toLowerCase()) {
        json(res, 403, { message: "Resource not accessible by integration" })
        return
      }
      if (suffix === "" && method === "GET") {
        json(res, 200, {
          id: 301,
          node_id: "R_widget",
          name: repo,
          full_name: `${owner}/${repo}`
        })
        return
      }

      if (suffix === "/pulls" && method === "GET") {
        json(res, 200, page(prs.map(pullJson), requestUrl))
        return
      }
      if (suffix === "/pulls" && method === "POST") {
        if (failures.delete("create-pr")) {
          operations.push("fail create-pr")
          json(res, 503, { message: "Injected pull request creation failure" })
          return
        }
        const body = await requestBody(req)
        operations.push(`pr create ${String(body.head ?? "")}`)
        publishedPr = {
          number: 900,
          title: String(body.title ?? ""),
          body: String(body.body ?? ""),
          head: String(body.head ?? ""),
          base: String(body.base ?? "")
        }
        prs.push({
          number: 900,
          title: publishedPr.title,
          body: publishedPr.body,
          headRefName: publishedPr.head,
          baseRefName: publishedPr.base,
          author: { login: options.userLogin ?? "octocat" }
        })
        json(res, 201, { number: 900 })
        return
      }
      const pullMatch = /^\/pulls\/(\d+)(.*)$/.exec(suffix)
      if (pullMatch) {
        const number = Number(pullMatch[1])
        const tail = pullMatch[2] ?? ""
        const pr = prs.find((candidate) => candidate.number === number)
        if (!pr) {
          json(res, 404, { message: "Not Found" })
          return
        }
        if (tail === "" && method === "GET") {
          if (String(req.headers.accept ?? "").includes("application/vnd.github.diff")) {
            text(
              res,
              200,
              options.diff ??
                "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1,2 @@\n one\n+two\n"
            )
          } else {
            json(res, 200, pullJson(pr))
          }
          return
        }
        if (tail === "" && method === "PATCH") {
          if (failures.delete("update-pr")) {
            operations.push("fail update-pr")
            json(res, 503, { message: "Injected pull request update failure" })
            return
          }
          const body = await requestBody(req)
          if (publishedPr?.number === number) {
            publishedPr = {
              ...publishedPr,
              title: String(body.title ?? publishedPr.title),
              body: String(body.body ?? publishedPr.body)
            }
          }
          operations.push(`pr update ${number}`)
          json(res, 200, pullJson({ ...pr, title: String(body.title ?? pr.title), body: String(body.body ?? pr.body) }))
          return
        }
        if (tail === "/files" && method === "GET") {
          json(res, 200, [
            {
              filename: "src/auth.ts",
              additions: pr.additions ?? 0,
              deletions: pr.deletions ?? 0,
              patch: "@@ -1 +1,2 @@\n one\n+two"
            }
          ])
          return
        }
        if (tail === "/reviews" && method === "GET") {
          json(res, 200, [])
          return
        }
        if (tail === "/reviews" && method === "POST") {
          operations.push(`pr review ${number}`)
          json(res, 200, {})
          return
        }
        if (tail === "/requested_reviewers" && method === "GET") {
          json(res, 200, { users: [], teams: [] })
          return
        }
        if (tail === "/merge" && method === "PUT") {
          const body = await requestBody(req)
          operations.push(`pr merge ${number} --${String(body.merge_method ?? "merge")}`)
          json(res, 200, { merged: true })
          return
        }
        if (tail === "/update-branch" && method === "PUT") {
          operations.push(`pr update-branch ${number}`)
          json(res, 202, { message: "Updating" })
          return
        }
        const replyMatch = /^\/comments\/(\d+)\/replies$/.exec(tail)
        if (replyMatch && method === "POST") {
          operations.push(`pr reply ${number}`)
          json(res, 201, {})
          return
        }
      }

      const checksMatch = /^\/commits\/([^/]+)\/check-runs$/.exec(suffix)
      if (checksMatch && method === "GET") {
        const pr = prs.find((candidate) => `e2ehead${candidate.number}` === checksMatch[1])
        json(res, 200, {
          check_runs: (pr?.checks ?? []).map((check) => ({
            name: check.name,
            status: check.status ?? "completed",
            conclusion: check.conclusion ?? "success",
            details_url: check.detailsUrl ?? null,
            started_at: "2026-07-11T00:00:00Z",
            completed_at: "2026-07-11T00:00:48Z"
          }))
        })
        return
      }
      if (/^\/commits\/[^/]+\/status$/.test(suffix) && method === "GET") {
        json(res, 200, { statuses: [] })
        return
      }

      if (suffix === "/issues" && method === "GET") {
        json(res, 200, page(issues.map(issueJson), requestUrl))
        return
      }
      const issueMatch = /^\/issues\/(\d+)(.*)$/.exec(suffix)
      if (issueMatch) {
        const number = Number(issueMatch[1])
        const tail = issueMatch[2] ?? ""
        const issue = issues.find((candidate) => candidate.number === number)
        const pr = prs.find((candidate) => candidate.number === number)
        if (tail === "" && method === "GET" && issue) {
          json(res, 200, issueJson(issue))
          return
        }
        if (tail === "/comments" && method === "GET") {
          json(res, 200, [])
          return
        }
        if (tail === "/comments" && method === "POST") {
          operations.push(`${pr ? "pr" : "issue"} comment ${number}`)
          json(res, 201, {})
          return
        }
        if (tail === "" && method === "PATCH") {
          operations.push(`issue close ${number}`)
          json(res, 200, issue ? { ...issueJson(issue), state: "closed" } : {})
          return
        }
      }

      json(res, 404, { message: "Not found" })
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })

  return {
    url,
    requests,
    operations,
    connect: () => {
      connected = true
      lastRefreshedAt = "2026-08-04T09:00:00.000Z"
    },
    setInstallation: (patch) => {
      installation = {
        ...installation,
        ...patch,
        account: patch.account ?? installation.account
      }
    },
    failNext: (operation) => {
      failures.add(operation)
    },
    status,
    publishedPr: () => publishedPr,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}
