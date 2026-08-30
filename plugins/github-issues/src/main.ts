/**
 * The host half: fetching an issue through the authenticated GitHub CLI, with
 * a short-lived GitHub App installation credential as fallback. Credentials
 * remain in the extension host; the renderer receives only normalized data.
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

const normalizeIssue = async (
  value: unknown,
  loadComments?: () => Promise<ReadonlyArray<IssueComment>>
): Promise<IssuePayload | null> => {
  const issue = record(value)
  const number = issue?.number
  const title = string(issue?.title)
  const state = string(issue?.state)
  const url = string(issue?.url)
  const createdAt = string(issue?.createdAt)
  if (!issue || typeof number !== "number" || !title || !state || !url || !createdAt) return null

  const author = user(issue.author)
  return {
    number,
    title,
    body: string(issue.body) ?? "",
    state: state.toLowerCase(),
    url,
    labels: Array.isArray(issue.labels)
      ? issue.labels.flatMap((value) => {
          const label = record(value)
          const name = string(label?.name)
          if (!name) return []
          const color = string(label?.color)
          return [{ name, ...(color ? { color } : {}) }]
        })
      : [],
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.flatMap((value) => {
          const assignee = user(value)
          return assignee ? [assignee] : []
        })
      : [],
    comments: loadComments ? await loadComments() : Array.isArray(issue.comments)
      ? issue.comments.flatMap((value) => {
          const comment = record(value)
          const body = string(comment?.body)
          const commentCreatedAt = string(comment?.createdAt)
          if (body === null || !commentCreatedAt) return []
          const commentAuthor = user(comment?.author)
          return [{ body, createdAt: commentCreatedAt, ...(commentAuthor ? { author: commentAuthor } : {}) }]
        })
      : [],
    createdAt,
    ...(author ? { author } : {})
  }
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
  if (!issue) throw new Error("GitHub returned an invalid issue.")
  const normalized = await normalizeIssue({
    ...issue,
    url: issue.html_url,
    author: issue.user,
    createdAt: issue.created_at
  }, () => comments(
    request,
    `${base}/issues/${input.issueNumber}/comments?per_page=100`,
    session.accessToken
  ))
  if (!normalized) throw new Error("GitHub returned an invalid issue.")
  return normalized
}

const CLI_FIELDS = [
  "number", "title", "body", "state", "url", "author", "labels", "assignees", "comments", "createdAt"
].join(",")

/** Prefer the operator's authenticated GitHub CLI without exposing its token. */
export const fetchIssueWithCli = async (
  input: FetchArgs,
  exec: (
    command: string,
    args?: readonly string[],
    options?: { readonly cwd?: string; readonly timeoutMs?: number }
  ) => Promise<ExecResult>
): Promise<IssuePayload | null> => {
  repositoryParts(input.repo)
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error("The linked GitHub issue number is invalid.")
  }
  const options = { ...(input.worktreePath ? { cwd: input.worktreePath } : {}), timeoutMs: 10_000 }
  let auth: ExecResult
  try {
    auth = await exec("gh", ["auth", "status", "--active", "--hostname", "github.com"], options)
  } catch {
    return null
  }
  if (auth.code !== 0) return null
  const result = await exec("gh", [
    "issue", "view", String(input.issueNumber), "--repo", input.repo, "--json", CLI_FIELDS
  ], options).catch(() => null)
  if (result?.code !== 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(result.stdout) as unknown
  } catch {
    return null
  }
  const issue = record(raw)
  const number = issue?.number
  const title = string(issue?.title)
  const state = string(issue?.state)
  const url = string(issue?.url)
  const createdAt = string(issue?.createdAt)
  if (!issue || typeof number !== "number" || !title || !state || !url || !createdAt) {
    return null
  }
  const author = user(issue.author)
  return {
    number,
    title,
    body: string(issue.body) ?? "",
    state: state.toLowerCase(),
    url,
    labels: Array.isArray(issue.labels)
      ? issue.labels.flatMap((value) => {
          const label = record(value)
          const name = string(label?.name)
          if (!name) return []
          const color = string(label?.color)
          return [{ name, ...(color ? { color } : {}) }]
        })
      : [],
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.flatMap((value) => {
          const assignee = user(value)
          return assignee ? [assignee] : []
        })
      : [],
    comments: Array.isArray(issue.comments)
      ? issue.comments.flatMap((value) => {
          const comment = record(value)
          const body = string(comment?.body)
          const commentCreatedAt = string(comment?.createdAt)
          if (body === null || !commentCreatedAt) return []
          const commentAuthor = user(comment?.author)
          return [{ body, createdAt: commentCreatedAt, ...(commentAuthor ? { author: commentAuthor } : {}) }]
        })
      : [],
    createdAt,
    ...(author ? { author } : {})
  }
}

export const activate: Activate = (ctx) => {
  ctx.subscriptions.push(
    ctx.commands.register("github-issues.fetch", async (input) => {
      const args = input as FetchArgs
      const repo = await resolveRepository(args.repo, args.worktreePath, ctx.exec)
      const resolved = { ...args, repo }
      const cliIssue = await fetchIssueWithCli(resolved, ctx.exec)
      if (cliIssue) return cliIssue
      const session = await ctx.authentication.getSession("github", [
        "issues:read",
        `repository:${repo}`
      ])
      return fetchIssue(resolved, session)
    })
  )

  ctx.log.info("GitHub Issues ready")
}
