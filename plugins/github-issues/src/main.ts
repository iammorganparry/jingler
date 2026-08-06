/**
 * The host half: fetching an issue through a short-lived GitHub App
 * installation credential. Network and credentials remain in the extension
 * host; the renderer receives only the normalized issue payload.
 */
import type { Activate, AuthSession, ExecResult } from "@jingler/plugin-sdk/host"

interface FetchArgs {
  readonly repo: string
  readonly issueNumber: number
  readonly worktreePath?: string
}

interface GitHubUser {
  readonly login: string
}

interface IssueComment {
  readonly author?: GitHubUser
  readonly body: string
  readonly createdAt: string
}

export interface IssuePayload {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: string
  readonly url: string
  readonly author?: GitHubUser
  readonly labels: ReadonlyArray<{ readonly name: string; readonly color?: string }>
  readonly assignees: ReadonlyArray<GitHubUser>
  readonly comments: ReadonlyArray<IssueComment>
  readonly createdAt: string
}

type Request = (input: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>

const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)$/
const LINK = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/
const WHITESPACE = /\s+/
const HTTPS_REMOTE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i
const SCP_REMOTE = /^(?:[^@]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i
const SSH_REMOTE = /^ssh:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const string = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const repositoryParts = (repo: string): readonly [string, string] => {
  const match = REPOSITORY.exec(repo)
  if (!(match?.[1] && match[2])) throw new Error("The linked GitHub repository is invalid.")
  return [match[1], match[2]]
}

const repositoryFromRemote = (remote: string): string | null => {
  const value = remote.trim()
  const match = HTTPS_REMOTE.exec(value) ?? SCP_REMOTE.exec(value) ?? SSH_REMOTE.exec(value)
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null
}

/** Resolve legacy folder-only session names without granting the renderer more repository data. */
export const resolveRepository = async (
  repo: string,
  worktreePath: string | undefined,
  exec: (
    command: string,
    args?: readonly string[],
    options?: { readonly cwd?: string; readonly timeoutMs?: number }
  ) => Promise<ExecResult>
): Promise<string> => {
  if (REPOSITORY.test(repo)) return repo
  if (!worktreePath) throw new Error("The linked session has no GitHub repository identity.")
  const result = await exec("git", ["remote", "get-url", "origin"], {
    cwd: worktreePath,
    timeoutMs: 5_000
  })
  const resolved = result.code === 0 ? repositoryFromRemote(result.stdout) : null
  if (!resolved) throw new Error("The linked session's origin is not a GitHub repository.")
  return resolved
}

const user = (value: unknown): GitHubUser | undefined => {
  const candidate = record(value)
  const login = string(candidate?.login)
  return login ? { login } : undefined
}

const nextPage = (response: Response): string | null => {
  const link = response.headers.get("link")
  if (!link) return null
  for (const entry of link.split(",")) {
    const match = LINK.exec(entry)
    if (match?.[2]?.split(WHITESPACE).includes("next")) return match[1] ?? null
  }
  return null
}

const requestJson = async (
  request: Request,
  url: string,
  token: string
): Promise<{ readonly value: unknown; readonly response: Response }> => {
  const response = await request(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28"
    }
  })
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("GitHub could not find this issue or the App cannot access its repository.")
    }
    if (response.status === 401) {
      throw new Error("The GitHub connection expired. Reconnect it in Settings and retry.")
    }
    if (response.status === 403) {
      throw new Error("The Jingler GitHub App does not have access to this issue.")
    }
    if (response.status === 429) {
      throw new Error("GitHub's rate limit was reached. Retry after it resets.")
    }
    throw new Error(`GitHub could not load this issue (HTTP ${response.status}).`)
  }
  return { value: await response.json(), response }
}

const comments = async (
  request: Request,
  firstUrl: string,
  token: string
): Promise<ReadonlyArray<IssueComment>> => {
  const result: IssueComment[] = []
  let url: string | null = firstUrl
  let pages = 0
  while (url && pages < 100) {
    // GitHub's Link header reveals the next page only after this response, so
    // comment pagination is intentionally sequential.
    // biome-ignore lint/performance/noAwaitInLoops: pagination is data-dependent
    const page = await requestJson(request, url, token)
    if (!Array.isArray(page.value)) throw new Error("GitHub returned invalid issue comments.")
    for (const value of page.value) {
      const candidate = record(value)
      const body = string(candidate?.body)
      const createdAt = string(candidate?.created_at)
      if (!candidate || body === null || !createdAt) continue
      const author = user(candidate.user)
      result.push({
        body,
        createdAt,
        ...(author ? { author } : {})
      })
    }
    url = nextPage(page.response)
    pages += 1
  }
  if (url) throw new Error("GitHub returned too many comment pages for this issue.")
  return result
}

/** Fetch and normalize one linked issue without returning credentials or raw responses. */
export const fetchIssue = async (
  input: FetchArgs,
  session: Pick<AuthSession, "accessToken" | "apiBaseUrl">,
  request: Request = fetch
): Promise<IssuePayload> => {
  const [owner, name] = repositoryParts(input.repo)
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error("The linked GitHub issue number is invalid.")
  }
  if (session.apiBaseUrl !== "https://api.github.com") {
    throw new Error("The GitHub API connection is unavailable. Reconnect it in Settings.")
  }
  const base = `${session.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  const issueResult = await requestJson(
    request,
    `${base}/issues/${input.issueNumber}`,
    session.accessToken
  )
  const issue = record(issueResult.value)
  const number = issue?.number
  const title = string(issue?.title)
  const state = string(issue?.state)
  const url = string(issue?.html_url)
  const createdAt = string(issue?.created_at)
  if (!issue || typeof number !== "number" || !title || !state || !url || !createdAt) {
    throw new Error("GitHub returned an invalid issue.")
  }

  const labels = Array.isArray(issue.labels)
    ? issue.labels.flatMap((value) => {
        const label = record(value)
        const labelName = string(label?.name)
        if (!labelName) return []
        const color = string(label?.color)
        return [{ name: labelName, ...(color ? { color } : {}) }]
      })
    : []
  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees.flatMap((value) => {
        const assignee = user(value)
        return assignee ? [assignee] : []
      })
    : []
  const author = user(issue.user)

  return {
    number,
    title,
    body: string(issue.body) ?? "",
    state,
    url,
    labels,
    assignees,
    comments: await comments(
      request,
      `${base}/issues/${input.issueNumber}/comments?per_page=100`,
      session.accessToken
    ),
    createdAt,
    ...(author ? { author } : {})
  }
}

export const activate: Activate = (ctx) => {
  ctx.subscriptions.push(
    ctx.commands.register("github-issues.fetch", async (input) => {
      const args = input as FetchArgs
      const repo = await resolveRepository(args.repo, args.worktreePath, ctx.exec)
      const session = await ctx.authentication.getSession("github", [
        "issues:read",
        `repository:${repo}`
      ])
      return fetchIssue({ ...args, repo }, session)
    })
  )

  ctx.log.info("GitHub Issues ready")
}
