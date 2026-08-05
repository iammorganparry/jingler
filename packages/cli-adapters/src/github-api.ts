import type {
  GitHubRateLimit,
  Issue,
  IssueSummary,
  PrCheck,
  PrFileChange,
  PrMergeMethod,
  PrSummary,
  PullRequest,
  ReviewSubmitKind,
  SessionPrStatus
} from "@jingler/core"
import { GitHubApiError } from "@jingler/core"
import type { CommandExecutor } from "@effect/platform"
import { App } from "@octokit/app"
import { request as octokitRequest } from "@octokit/request"
import { Effect, Runtime } from "effect"
import { branchAt } from "./git.js"
import { GitHubAuth, type GitHubInstallationCredential } from "./github-auth.js"
import {
  mapApiFiles,
  mapCheck,
  mapIssue,
  mapIssueSummary,
  mapPrState,
  mapPrSummary,
  mapPrView,
  mapRateLimit,
  mapReviewThreads,
  unifiedDiffFromApiFiles
} from "./github-mappers.js"
import { runGit, runString } from "./command.js"

const API_VERSION = "2022-11-28"
const JSON_ACCEPT = "application/vnd.github+json"
const PAGE_SIZE = 100
const MAX_PAGES = 100

const paginationLimitError = (resource: string): GitHubApiError =>
  new GitHubApiError({
    reason: "unavailable",
    message: `GitHub returned more ${resource} than Jingler can safely load. Narrow the request and retry.`
  })

type RequestParameters = Readonly<Record<string, unknown>> & {
  readonly headers?: Readonly<Record<string, string>>
}
type ResponseHeaders = Readonly<Record<string, string | number | undefined>>

/** Exposed for diagnostics without constructing an app client in Electron. */
export const OCTOKIT_APP_VERSION = App.VERSION

export interface GitHubRepository {
  /** Immutable REST database id. */
  readonly id: string
  /** Immutable GraphQL node id. */
  readonly nodeId: string
  readonly owner: string
  readonly name: string
  readonly fullName: string
  readonly installationId: string
}

export interface GitHubPullRequestHead {
  readonly repositoryId: string
  readonly fullName: string
  readonly ref: string
  readonly sha: string
  readonly cloneUrl: string
  readonly sshUrl: string | null
}

export interface GitHubApiResult<A> {
  readonly data: A
  readonly rateLimit: GitHubRateLimit
}

export interface GitHubApiClient {
  readonly repository: (cwd: string) => Promise<GitHubRepository>
  readonly rateLimit: () => GitHubRateLimit | null
  readonly prForBranch: (cwd: string, branch: string) => Promise<number | null>
  readonly prForWorktree: (cwd: string) => Promise<number | null>
  readonly listPrs: (
    cwd: string,
    options: { readonly mine: boolean; readonly search: string }
  ) => Promise<ReadonlyArray<PrSummary>>
  readonly listIssues: (
    cwd: string,
    options: { readonly mine: boolean; readonly search: string }
  ) => Promise<ReadonlyArray<IssueSummary>>
  readonly issueView: (cwd: string, number: number) => Promise<Issue | null>
  readonly prState: (cwd: string, number: number) => Promise<SessionPrStatus | null>
  readonly prHeadSha: (cwd: string, number: number) => Promise<string | null>
  readonly prView: (cwd: string, number: number) => Promise<PullRequest | null>
  readonly prFiles: (cwd: string, number: number) => Promise<ReadonlyArray<PrFileChange>>
  readonly prDiff: (cwd: string, number: number) => Promise<string>
  readonly prCheckout: (cwd: string, number: number) => Promise<GitHubPullRequestHead>
  readonly prCreate: (
    cwd: string,
    input: { readonly title: string; readonly body: string; readonly base: string; readonly draft: boolean }
  ) => Promise<number>
  readonly prUpdate: (cwd: string, number: number, input: { readonly title: string; readonly body: string }) => Promise<void>
  readonly prComment: (cwd: string, number: number, body: string) => Promise<void>
  readonly prReviewComments: (
    cwd: string,
    number: number,
    input: {
      readonly commitSha: string
      readonly body: string
      readonly comments: ReadonlyArray<{
        readonly path: string
        readonly line: number
        readonly startLine: number | null
        readonly body: string
      }>
    }
  ) => Promise<void>
  readonly prReview: (
    cwd: string,
    number: number,
    kind: ReviewSubmitKind,
    body: string
  ) => Promise<void>
  readonly resolveThread: (cwd: string, threadId: string, resolved: boolean) => Promise<void>
  readonly replyToThread: (
    cwd: string,
    number: number,
    commentId: number,
    body: string
  ) => Promise<void>
  readonly prMerge: (cwd: string, number: number, method?: PrMergeMethod) => Promise<void>
  readonly prUpdateBranch: (cwd: string, number: number) => Promise<void>
  readonly prReady: (cwd: string, number: number) => Promise<void>
  readonly issueComment: (cwd: string, number: number, body: string) => Promise<void>
  readonly closeIssue: (cwd: string, number: number) => Promise<void>
}

export interface GitHubApiClientOptions {
  readonly auth: {
    readonly viewerLogin: () => Promise<string | null>
    readonly credentialsForOwner: (
      owner: string,
      repository: string,
      permissions: ReadonlyArray<string>
    ) => Promise<GitHubInstallationCredential>
    readonly invalidate: (installationId: string) => void
  }
  readonly remoteUrl: (cwd: string) => Promise<string | null>
  readonly branch: (cwd: string) => Promise<string | null>
  readonly git: (cwd: string, args: ReadonlyArray<string>) => Promise<string>
  readonly gitText: (cwd: string, args: ReadonlyArray<string>) => Promise<string | null>
  readonly fetch?: typeof fetch
  /** Defaults to GitHub.com; overridden only by hermetic HTTP integration tests. */
  readonly apiBaseUrl?: string
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const records = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.map(record) : []

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

export const parseGitHubRemote = (
  remote: string
): { readonly owner: string; readonly repo: string } | null => {
  const trimmed = remote.trim()
  const match =
    trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i) ??
    trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i) ??
    trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i)
  if (!match?.[1] || !match[2]) return null
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") }
}

const headersRecord = (headers: ResponseHeaders): Readonly<Record<string, string | undefined>> =>
  Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      value === undefined ? undefined : String(value)
    ])
  )

const retryAtFrom = (
  headers: Readonly<Record<string, string | undefined>>,
  now = Date.now()
): string | undefined => {
  const retryAfter = headers["retry-after"]
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return new Date(now + seconds * 1_000).toISOString()
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return new Date(date).toISOString()
  }
  const reset = Number(headers["x-ratelimit-reset"])
  return Number.isFinite(reset) ? new Date(reset * 1_000).toISOString() : undefined
}

const messageFrom = (error: unknown): string => {
  const response = record(record(error).response)
  const data = record(response.data)
  return text(data.message) ?? text(record(error).message) ?? ""
}

const githubError = (
  error: unknown,
  repository?: string,
  installationId?: string
): GitHubApiError => {
  if (error instanceof GitHubApiError) return error
  const raw = record(error)
  const response = record(raw.response)
  const status = number(raw.status) ?? number(response.status) ?? undefined
  const responseHeaders = headersRecord(record(response.headers) as ResponseHeaders)
  const upstreamMessage = messageFrom(error)
  const remaining = responseHeaders["x-ratelimit-remaining"]
  const secondaryRateLimit =
    status === 403 &&
    (responseHeaders["retry-after"] !== undefined ||
      /secondary rate limit|abuse detection|temporarily blocked/i.test(upstreamMessage))
  const retryAt = retryAtFrom(responseHeaders) ??
    (secondaryRateLimit ? new Date(Date.now() + 60_000).toISOString() : undefined)
  if (status === 401) {
    return new GitHubApiError({
      reason: "token-expired",
      message: "The short-lived GitHub grant expired. Refresh GitHub and retry.",
      status,
      ...(repository ? { repository } : {}),
      ...(installationId ? { installationId } : {})
    })
  }
  if (status === 429 || remaining === "0" || secondaryRateLimit) {
    return new GitHubApiError({
      reason: "rate-limited",
      message: retryAt
        ? `GitHub's rate limit was reached. Retry after ${retryAt}.`
        : "GitHub's rate limit was reached. Retry after it resets.",
      ...(status === undefined ? {} : { status }),
      ...(retryAt ? { retryAt } : {}),
      ...(repository ? { repository } : {}),
      ...(installationId ? { installationId } : {})
    })
  }
  if (status === 403 && /suspend/i.test(upstreamMessage)) {
    return new GitHubApiError({
      reason: "installation-suspended",
      message: "This GitHub App installation is suspended. Resume it in GitHub and refresh.",
      status,
      ...(repository ? { repository } : {}),
      ...(installationId ? { installationId } : {})
    })
  }
  if (status === 403) {
    return new GitHubApiError({
      reason: "repository-access",
      message: repository
        ? `${repository} is outside the GitHub App installation's repository access. Manage repositories, then refresh.`
        : "The GitHub App installation does not grant access to this repository.",
      status,
      ...(repository ? { repository } : {}),
      ...(installationId ? { installationId } : {})
    })
  }
  if (status === 422) {
    return new GitHubApiError({
      reason: "validation",
      message: "GitHub rejected the submitted values. Refresh the pull request and correct the highlighted action.",
      status,
      ...(repository ? { repository } : {}),
      ...(installationId ? { installationId } : {})
    })
  }
  if (status === 404) {
    return new GitHubApiError({
      reason: "not-found",
      message: repository
        ? `${repository} or the requested GitHub resource was not found. Refresh repository access.`
        : "The requested GitHub resource was not found.",
      status,
      ...(repository ? { repository } : {}),
      ...(installationId ? { installationId } : {})
    })
  }
  return new GitHubApiError({
    reason: "unavailable",
    message: "GitHub could not complete the request. Check the connection and retry.",
    ...(status === undefined ? {} : { status }),
    ...(repository ? { repository } : {}),
    ...(installationId ? { installationId } : {})
  })
}

const reviewEvent = (kind: ReviewSubmitKind): "COMMENT" | "APPROVE" | "REQUEST_CHANGES" =>
  kind === "approve" ? "APPROVE" : kind === "request-changes" ? "REQUEST_CHANGES" : "COMMENT"

const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line startLine originalLine originalStartLine
          resolvedBy{ login }
          comments(first:100){
            nodes{
              id databaseId body createdAt diffHunk authorAssociation
              author{ login avatarUrl __typename }
              pullRequestReview{ id }
              reactionGroups{ content reactors{ totalCount } }
            }
          }
        }
      }
    }
  }
}`

const RESOLVE_THREAD_MUTATION = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } }
}`
const UNRESOLVE_THREAD_MUTATION = `mutation($id:ID!){
  unresolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } }
}`
const READY_MUTATION = `mutation($id:ID!){
  markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest{ id isDraft } }
}`

export const makeGitHubApiClient = (options: GitHubApiClientOptions): GitHubApiClient => {
  const repositoryCache = new Map<string, { readonly remote: string; readonly repository: GitHubRepository }>()
  let latestRateLimit: GitHubRateLimit | null = null

  const call = async <A>(
    grant: GitHubInstallationCredential,
    method: string,
    url: string,
    parameters: RequestParameters = {},
    repository?: string
  ): Promise<GitHubApiResult<A>> => {
    const request = octokitRequest.defaults({
      baseUrl: options.apiBaseUrl ?? "https://api.github.com",
      headers: {
        accept: JSON_ACCEPT,
        authorization: `Bearer ${grant.token}`,
        "x-github-api-version": API_VERSION
      },
      request: { fetch: options.fetch ?? fetch }
    })
    try {
      const response = await request<A>({ method, url, ...parameters })
      latestRateLimit = mapRateLimit(headersRecord(response.headers))
      return { data: response.data, rateLimit: latestRateLimit }
    } catch (error) {
      const mapped = githubError(error, repository, grant.installationId)
      if (mapped.reason === "token-expired") options.auth.invalidate(grant.installationId)
      throw mapped
    }
  }

  const resolveRepository = async (cwd: string): Promise<GitHubRepository> => {
    const remote = await options.remoteUrl(cwd)
    if (!remote) {
      throw new GitHubApiError({
        reason: "not-found",
        message: "This repository has no origin remote to resolve on GitHub."
      })
    }
    const cached = repositoryCache.get(cwd)
    if (cached?.remote === remote) return cached.repository
    const parsed = parseGitHubRemote(remote)
    if (!parsed) {
      throw new GitHubApiError({
        reason: "not-found",
        message: "The origin remote is not a github.com repository."
      })
    }
    const slug = `${parsed.owner}/${parsed.repo}`
    // GitHub's metadata permission is implicit and cannot be used to narrow a
    // token. A repository-qualified contents:read token is the least explicit
    // scope that safely resolves immutable repository identity.
    const grant = await options.auth.credentialsForOwner(parsed.owner, slug, ["contents:read"])
    const { data } = await call<Record<string, unknown>>(
      grant,
      "GET",
      "/repos/{owner}/{repo}",
      { owner: parsed.owner, repo: parsed.repo },
      slug
    )
    const id = number(data.id)
    const nodeId = text(data.node_id)
    const fullName = text(data.full_name)
    if (id === null || !nodeId || !fullName || !fullName.includes("/")) {
      throw new GitHubApiError({
        reason: "unavailable",
        message: "GitHub returned invalid repository metadata.",
        repository: slug,
        installationId: grant.installationId
      })
    }
    const [owner, ...nameParts] = fullName.split("/")
    const repository: GitHubRepository = {
      id: String(id),
      nodeId,
      owner: owner!,
      name: nameParts.join("/"),
      fullName,
      installationId: grant.installationId
    }
    repositoryCache.set(cwd, { remote, repository })
    return repository
  }

  const grantForRepository = (repository: GitHubRepository, scopes: ReadonlyArray<string>) =>
    options.auth.credentialsForOwner(repository.owner, repository.fullName, scopes)

  const repositoryCall = async <A>(
    cwd: string,
    method: string,
    url: string,
    parameters: RequestParameters,
    scopes: ReadonlyArray<string>
  ): Promise<GitHubApiResult<A>> => {
    const repository = await resolveRepository(cwd)
    const grant = await grantForRepository(repository, scopes)
    return call<A>(
      grant,
      method,
      url,
      { owner: repository.owner, repo: repository.name, ...parameters },
      repository.fullName
    )
  }

  const paginate = async (
    cwd: string,
    url: string,
    parameters: RequestParameters,
    scopes: ReadonlyArray<string>
  ): Promise<ReadonlyArray<Record<string, unknown>>> => {
    const output: Array<Record<string, unknown>> = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await repositoryCall<unknown[]>(
        cwd,
        "GET",
        url,
        { ...parameters, per_page: PAGE_SIZE, page },
        scopes
      )
      const pageRows = records(response.data)
      output.push(...pageRows)
      if (pageRows.length < PAGE_SIZE) break
      if (page === MAX_PAGES) throw paginationLimitError("results")
    }
    return output
  }

  const pull = async (cwd: string, pullNumber: number): Promise<Record<string, unknown>> =>
    (
      await repositoryCall<Record<string, unknown>>(
        cwd,
        "GET",
        "/repos/{owner}/{repo}/pulls/{pull_number}",
        { pull_number: pullNumber },
        ["pull_requests:read"]
      )
    ).data

  const checksFor = async (cwd: string, sha: string): Promise<ReadonlyArray<PrCheck>> => {
    const checks: Array<PrCheck> = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await repositoryCall<Record<string, unknown>>(
        cwd,
        "GET",
        "/repos/{owner}/{repo}/commits/{ref}/check-runs",
        { ref: sha, per_page: PAGE_SIZE, page },
        ["checks:read"]
      )
      const pageRows = records(response.data.check_runs)
      checks.push(...pageRows.map(mapCheck))
      if (pageRows.length < PAGE_SIZE) break
      if (page === MAX_PAGES) throw paginationLimitError("check runs")
    }
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      let response: GitHubApiResult<Record<string, unknown>>
      try {
        response = await repositoryCall<Record<string, unknown>>(
          cwd,
          "GET",
          "/repos/{owner}/{repo}/commits/{ref}/status",
          { ref: sha, per_page: PAGE_SIZE, page },
          ["statuses:read"]
        )
      } catch (error) {
        if (error instanceof GitHubApiError && error.reason === "not-found") break
        throw error
      }
      const pageRows = records(response.data.statuses)
      checks.push(...pageRows.map(mapCheck))
      if (pageRows.length < PAGE_SIZE) break
      if (page === MAX_PAGES) throw paginationLimitError("commit statuses")
    }
    return checks
  }

  const reviewThreads = async (
    cwd: string,
    repository: GitHubRepository,
    pullNumber: number
  ): Promise<ReturnType<typeof mapReviewThreads>> => {
    const grant = await grantForRepository(repository, ["pull_requests:read"])
    const output: Array<ReturnType<typeof mapReviewThreads>[number]> = []
    let after: string | null = null
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await call<Record<string, unknown>>(
        grant,
        "POST",
        "/graphql",
        {
          query: REVIEW_THREADS_QUERY,
          variables: {
            owner: repository.owner,
            repo: repository.name,
            number: pullNumber,
            after
          }
        },
        repository.fullName
      )
      output.push(...mapReviewThreads(response.data))
      const data = record(response.data.data)
      const repo = record(data.repository)
      const pr = record(repo.pullRequest)
      const connection = record(pr.reviewThreads)
      const pageInfo = record(connection.pageInfo)
      if (pageInfo.hasNextPage !== true || !text(pageInfo.endCursor)) break
      if (page === MAX_PAGES) throw paginationLimitError("review threads")
      after = text(pageInfo.endCursor)
    }
    return output
  }

  const prFiles = (cwd: string, pullNumber: number): Promise<ReadonlyArray<PrFileChange>> =>
    paginate(cwd, "/repos/{owner}/{repo}/pulls/{pull_number}/files", {
      pull_number: pullNumber
    }, ["pull_requests:read"]).then(mapApiFiles)

  const prForBranch = async (cwd: string, branch: string): Promise<number | null> => {
    const repository = await resolveRepository(cwd)
    const pulls = await paginate(cwd, "/repos/{owner}/{repo}/pulls", {
      state: "open",
      head: `${repository.owner}:${branch}`
    }, ["pull_requests:read"])
    const match = pulls.find((candidate) => {
      const head = record(candidate.head)
      const headRepository = record(head.repo)
      return (
        text(head.ref) === branch &&
        String(number(headRepository.id)) === repository.id &&
        text(headRepository.full_name)?.toLowerCase() === repository.fullName.toLowerCase()
      )
    })
    return match ? number(match.number) : null
  }

  const client: GitHubApiClient = {
    repository: resolveRepository,
    rateLimit: () => latestRateLimit,
    prForBranch,
    prForWorktree: async (cwd) => {
      const current = await options.branch(cwd)
      return current ? prForBranch(cwd, current) : null
    },
    listPrs: async (cwd, listOptions) => {
      const pulls = await paginate(
        cwd,
        "/repos/{owner}/{repo}/pulls",
        { state: "open" },
        ["pull_requests:read"]
      )
      const viewer = listOptions.mine ? await options.auth.viewerLogin() : null
      const search = listOptions.search.trim().toLowerCase()
      return pulls
        .filter((candidate) => {
          if (listOptions.mine && !viewer) return false
          if (viewer && text(record(candidate.user).login)?.toLowerCase() !== viewer.toLowerCase()) {
            return false
          }
          return (
            search.length === 0 ||
            (text(candidate.title) ?? "").toLowerCase().includes(search) ||
            (text(candidate.body) ?? "").toLowerCase().includes(search)
          )
        })
        .map(mapPrSummary)
    },
    listIssues: async (cwd, listOptions) => {
      const issues = await paginate(
        cwd,
        "/repos/{owner}/{repo}/issues",
        { state: "open" },
        ["issues:read"]
      )
      const viewer = listOptions.mine ? await options.auth.viewerLogin() : null
      const search = listOptions.search.trim().toLowerCase()
      return issues
        .filter((candidate) => {
          if (candidate.pull_request !== undefined) return false
          if (listOptions.mine && !viewer) return false
          if (
            viewer &&
            !records(candidate.assignees).some(
              (assignee) => text(assignee.login)?.toLowerCase() === viewer!.toLowerCase()
            )
          ) {
            return false
          }
          return (
            search.length === 0 ||
            (text(candidate.title) ?? "").toLowerCase().includes(search) ||
            (text(candidate.body) ?? "").toLowerCase().includes(search)
          )
        })
        .map(mapIssueSummary)
    },
    issueView: async (cwd, issueNumber) => {
      try {
        const [issue, comments] = await Promise.all([
          repositoryCall<Record<string, unknown>>(
            cwd,
            "GET",
            "/repos/{owner}/{repo}/issues/{issue_number}",
            { issue_number: issueNumber },
            ["issues:read"]
          ),
          paginate(cwd, "/repos/{owner}/{repo}/issues/{issue_number}/comments", {
            issue_number: issueNumber
          }, ["issues:read"])
        ])
        return mapIssue({ ...issue.data, comments })
      } catch (error) {
        if (error instanceof GitHubApiError && error.reason === "not-found") return null
        throw error
      }
    },
    prState: async (cwd, pullNumber) => {
      try {
        const pr = await pull(cwd, pullNumber)
        const stateWithoutChecks = mapPrState(pr, [])
        if (stateWithoutChecks?.state === "merged" || stateWithoutChecks?.state === "closed") {
          return stateWithoutChecks
        }
        const sha = text(record(pr.head).sha)
        const checks = sha ? await checksFor(cwd, sha) : []
        return mapPrState(pr, checks)
      } catch (error) {
        if (error instanceof GitHubApiError && error.reason === "not-found") return null
        throw error
      }
    },
    prHeadSha: async (cwd, pullNumber) => {
      try {
        return text(record((await pull(cwd, pullNumber)).head).sha)
      } catch (error) {
        if (error instanceof GitHubApiError && error.reason === "not-found") return null
        throw error
      }
    },
    prView: async (cwd, pullNumber) => {
      try {
        const repository = await resolveRepository(cwd)
        const pr = await pull(cwd, pullNumber)
        const sha = text(record(pr.head).sha)
        const [files, reviews, comments, requested, checks, threads] = await Promise.all([
          prFiles(cwd, pullNumber),
          paginate(cwd, "/repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
            pull_number: pullNumber
          }, ["pull_requests:read"]),
          paginate(cwd, "/repos/{owner}/{repo}/issues/{issue_number}/comments", {
            issue_number: pullNumber
          }, ["pull_requests:read"]),
          repositoryCall<Record<string, unknown>>(
            cwd,
            "GET",
            "/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
            { pull_number: pullNumber },
            ["pull_requests:read"]
          ).then((response) => records(response.data.users)),
          sha ? checksFor(cwd, sha) : Promise.resolve([]),
          reviewThreads(cwd, repository, pullNumber)
        ])
        return {
          ...mapPrView({
            ...pr,
            files,
            reviews,
            comments,
            requested_reviewers: requested,
            checks
          }),
          reviewThreads: threads
        }
      } catch (error) {
        if (error instanceof GitHubApiError && error.reason === "not-found") return null
        throw error
      }
    },
    prFiles,
    prDiff: async (cwd, pullNumber) => {
      try {
        const response = await repositoryCall<string>(
          cwd,
          "GET",
          "/repos/{owner}/{repo}/pulls/{pull_number}",
          {
            pull_number: pullNumber,
            headers: { accept: "application/vnd.github.diff" }
          },
          ["pull_requests:read"]
        )
        return typeof response.data === "string" ? response.data : ""
      } catch (error) {
        if (!(error instanceof GitHubApiError) || (error.status !== 406 && error.reason !== "unavailable")) {
          throw error
        }
        const repository = await resolveRepository(cwd)
        const grant = await grantForRepository(repository, ["pull_requests:read"])
        const files: Array<Record<string, unknown>> = []
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const response = await call<unknown[]>(
            grant,
            "GET",
            "/repos/{owner}/{repo}/pulls/{pull_number}/files",
            {
              owner: repository.owner,
              repo: repository.name,
              pull_number: pullNumber,
              per_page: PAGE_SIZE,
              page
            },
            repository.fullName
          )
          const pageRows = records(response.data)
          files.push(...pageRows)
          if (pageRows.length < PAGE_SIZE) break
          if (page === MAX_PAGES) throw paginationLimitError("pull-request files")
        }
        return unifiedDiffFromApiFiles(files)
      }
    },
    prCheckout: async (cwd, pullNumber) => {
      const pr = await pull(cwd, pullNumber)
      const head = record(pr.head)
      const repository = record(head.repo)
      const repositoryId = number(repository.id)
      const fullName = text(repository.full_name)
      const ref = text(head.ref)
      const sha = text(head.sha)
      const cloneUrl = text(repository.clone_url)
      if (repositoryId === null || !fullName || !ref || !sha || !cloneUrl) {
        throw new GitHubApiError({
          reason: "validation",
          message: "GitHub did not return a fetchable pull-request head repository and ref."
        })
      }
      return {
        repositoryId: String(repositoryId),
        fullName,
        ref,
        sha,
        cloneUrl,
        sshUrl: text(repository.ssh_url)
      }
    },
    prCreate: async (cwd, input) => {
      const repository = await resolveRepository(cwd)
      const currentBranch = await options.branch(cwd)
      if (!currentBranch) {
        throw new GitHubApiError({
          reason: "validation",
          message: "Check out a branch before opening a pull request.",
          repository: repository.fullName
        })
      }
      const autofill = input.title.trim() === "" && input.body.trim() === ""
      const subject = autofill
        ? (await options.gitText(cwd, ["log", "-1", "--format=%s"])) ?? currentBranch
        : input.title
      const body = autofill
        ? (await options.gitText(cwd, ["log", "-1", "--format=%b"])) ?? ""
        : input.body
      const response = await repositoryCall<Record<string, unknown>>(
        cwd,
        "POST",
        "/repos/{owner}/{repo}/pulls",
        { title: subject, body, head: currentBranch, base: input.base, draft: input.draft },
        ["pull_requests:write"]
      )
      const created = number(response.data.number)
      if (created === null) {
        throw new GitHubApiError({
          reason: "unavailable",
          message: "The pull request was created but GitHub did not return its number.",
          repository: repository.fullName
        })
      }
      return created
    },
    prUpdate: async (cwd, pullNumber, input) => {
      await repositoryCall(
        cwd,
        "PATCH",
        "/repos/{owner}/{repo}/pulls/{pull_number}",
        { pull_number: pullNumber, title: input.title, body: input.body },
        ["pull_requests:write"]
      )
    },
    prComment: async (cwd, pullNumber, body) => {
      await repositoryCall(
        cwd,
        "POST",
        "/repos/{owner}/{repo}/issues/{issue_number}/comments",
        { issue_number: pullNumber, body },
        ["pull_requests:write"]
      )
    },
    prReviewComments: async (cwd, pullNumber, input) => {
      await repositoryCall(
        cwd,
        "POST",
        "/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          pull_number: pullNumber,
          commit_id: input.commitSha,
          body: input.body,
          event: "COMMENT",
          comments: input.comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            ...(comment.startLine === null || comment.startLine >= comment.line
              ? {}
              : { start_line: comment.startLine, start_side: "RIGHT" }),
            side: "RIGHT",
            body: comment.body
          }))
        },
        ["pull_requests:write"]
      )
    },
    prReview: async (cwd, pullNumber, kind, body) => {
      await repositoryCall(
        cwd,
        "POST",
        "/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { pull_number: pullNumber, event: reviewEvent(kind), ...(body ? { body } : {}) },
        ["pull_requests:write"]
      )
    },
    resolveThread: async (cwd, threadId, resolved) => {
      const repository = await resolveRepository(cwd)
      const grant = await grantForRepository(repository, ["pull_requests:write"])
      await call(
        grant,
        "POST",
        "/graphql",
        { query: resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION, variables: { id: threadId } },
        repository.fullName
      )
    },
    replyToThread: async (cwd, pullNumber, commentId, body) => {
      await repositoryCall(
        cwd,
        "POST",
        "/repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
        { pull_number: pullNumber, comment_id: commentId, body },
        ["pull_requests:write"]
      )
    },
    prMerge: async (cwd, pullNumber, method = "merge") => {
      await repositoryCall(
        cwd,
        "PUT",
        "/repos/{owner}/{repo}/pulls/{pull_number}/merge",
        { pull_number: pullNumber, merge_method: method },
        ["contents:write"]
      )
    },
    prUpdateBranch: async (cwd, pullNumber) => {
      await repositoryCall(
        cwd,
        "PUT",
        "/repos/{owner}/{repo}/pulls/{pull_number}/update-branch",
        { pull_number: pullNumber },
        ["pull_requests:write", "contents:write"]
      )
    },
    prReady: async (cwd, pullNumber) => {
      const repository = await resolveRepository(cwd)
      const pr = await pull(cwd, pullNumber)
      const id = text(pr.node_id)
      if (!id) {
        throw new GitHubApiError({
          reason: "validation",
          message: "GitHub did not return the pull request node id needed to mark it ready."
        })
      }
      const grant = await grantForRepository(repository, ["pull_requests:write"])
      await call(
        grant,
        "POST",
        "/graphql",
        { query: READY_MUTATION, variables: { id } },
        repository.fullName
      )
    },
    issueComment: async (cwd, issueNumber, body) => {
      await repositoryCall(
        cwd,
        "POST",
        "/repos/{owner}/{repo}/issues/{issue_number}/comments",
        { issue_number: issueNumber, body },
        ["issues:write"]
      )
    },
    closeIssue: async (cwd, issueNumber) => {
      await repositoryCall(
        cwd,
        "PATCH",
        "/repos/{owner}/{repo}/issues/{issue_number}",
        { issue_number: issueNumber, state: "closed" },
        ["issues:write"]
      )
    }
  }
  return client
}

export class GitHubApi extends Effect.Service<GitHubApi>()("@jingler/GitHubApi", {
  accessors: true,
  effect: Effect.gen(function* () {
    const auth = yield* GitHubAuth
    const runtime = yield* Effect.runtime<CommandExecutor.CommandExecutor>()
    const run = Runtime.runPromise(runtime)
    const client = makeGitHubApiClient({
      auth: {
        viewerLogin: () => run(auth.viewerLogin()),
        credentialsForOwner: (owner, repository, permissions) =>
          run(auth.credentialsForOwner(owner, repository, permissions)),
        invalidate: (installationId) => {
          Runtime.runSync(runtime)(auth.invalidate(installationId))
        }
      },
      remoteUrl: (cwd) => run(runString("git", "-C", cwd, "remote", "get-url", "origin")),
      branch: (cwd) => run(branchAt(cwd)),
      git: (cwd, args) => run(runGit(cwd, args)),
      gitText: (cwd, args) => run(runString("git", "-C", cwd, ...args)),
      apiBaseUrl: process.env.JINGLER_GITHUB_API_URL ?? "https://api.github.com"
    })
    const wrap = <A>(promise: () => Promise<A>): Effect.Effect<A, GitHubApiError> =>
      Effect.tryPromise({
        try: promise,
        catch: (error) => githubError(error)
      })
    return {
      repository: (cwd: string) => wrap(() => client.repository(cwd)),
      rateLimit: () => Effect.sync(client.rateLimit),
      prForBranch: (cwd: string, branch: string) => wrap(() => client.prForBranch(cwd, branch)),
      prForWorktree: (cwd: string) => wrap(() => client.prForWorktree(cwd)),
      listPrs: (cwd: string, options: { readonly mine: boolean; readonly search: string }) =>
        wrap(() => client.listPrs(cwd, options)),
      listIssues: (cwd: string, options: { readonly mine: boolean; readonly search: string }) =>
        wrap(() => client.listIssues(cwd, options)),
      issueView: (cwd: string, number: number) => wrap(() => client.issueView(cwd, number)),
      prState: (cwd: string, number: number) => wrap(() => client.prState(cwd, number)),
      prHeadSha: (cwd: string, number: number) => wrap(() => client.prHeadSha(cwd, number)),
      prView: (cwd: string, number: number) => wrap(() => client.prView(cwd, number)),
      prFiles: (cwd: string, number: number) => wrap(() => client.prFiles(cwd, number)),
      prDiff: (cwd: string, number: number) => wrap(() => client.prDiff(cwd, number)),
      prCheckout: (cwd: string, number: number) => wrap(() => client.prCheckout(cwd, number)),
      prCreate: (cwd: string, input: Parameters<GitHubApiClient["prCreate"]>[1]) =>
        wrap(() => client.prCreate(cwd, input)),
      prUpdate: (cwd: string, number: number, input: Parameters<GitHubApiClient["prUpdate"]>[2]) =>
        wrap(() => client.prUpdate(cwd, number, input)),
      prComment: (cwd: string, number: number, body: string) =>
        wrap(() => client.prComment(cwd, number, body)),
      prReviewComments: (
        cwd: string,
        number: number,
        input: Parameters<GitHubApiClient["prReviewComments"]>[2]
      ) => wrap(() => client.prReviewComments(cwd, number, input)),
      prReview: (cwd: string, number: number, kind: ReviewSubmitKind, body: string) =>
        wrap(() => client.prReview(cwd, number, kind, body)),
      resolveThread: (cwd: string, threadId: string, resolved: boolean) =>
        wrap(() => client.resolveThread(cwd, threadId, resolved)),
      replyToThread: (cwd: string, number: number, commentId: number, body: string) =>
        wrap(() => client.replyToThread(cwd, number, commentId, body)),
      prMerge: (cwd: string, number: number, method?: PrMergeMethod) =>
        wrap(() => client.prMerge(cwd, number, method)),
      prUpdateBranch: (cwd: string, number: number) =>
        wrap(() => client.prUpdateBranch(cwd, number)),
      prReady: (cwd: string, number: number) => wrap(() => client.prReady(cwd, number)),
      issueComment: (cwd: string, number: number, body: string) =>
        wrap(() => client.issueComment(cwd, number, body)),
      closeIssue: (cwd: string, number: number) => wrap(() => client.closeIssue(cwd, number))
    } as const
  })
}) {}
