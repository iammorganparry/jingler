import type {
  Issue,
  PrFileChange,
  PrMergeMethod,
  PullRequest,
  PullRequestListItem,
  ReviewSubmitKind,
  SessionPrStatus,
  GitHubCliAccount,
  GitHubTeam,
  GitHubTeamQueue,
  GitHubTeamPrResult
} from "@jingler/core"
import { GitHubApiError } from "@jingler/core"
import { Command, CommandExecutor } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, Stream } from "effect"
import {
  jsonRecord,
  mapApiFiles,
  mapIssue,
  mapIssueSummary,
  mapPrState,
  mapPrSummary,
  mapPrView,
  mapPullRequestListItem,
  mapReviewThreads
} from "./github-mappers.js"
import { fetchWithGitHubToken } from "./git.js"
import { withMacCliPath } from "./runtime/providers/native-cli-environment.js"

const PR_FIELDS = [
  "state", "number", "title", "body", "headRefName", "baseRefName", "headRefOid",
  "isDraft", "commits", "additions", "deletions", "author", "createdAt",
  "labels", "reviews", "comments", "reviewRequests", "statusCheckRollup", "mergeable",
  "mergeStateStatus", "mergedAt", "url"
].join(",")

const INBOX_QUERY = `query($endCursor:String){
  viewer{login}
  search(query:"is:pr is:open involves:@me sort:updated-desc",type:ISSUE,first:100,after:$endCursor){
    nodes{... on PullRequest{
      assignees(first:100){nodes{login}} author{login avatarUrl} comments{totalCount} isDraft
      labels(first:100){nodes{name color}} number repository{nameWithOwner}
      reviewRequests(first:100){nodes{requestedReviewer{... on User{login}}}}
      state title updatedAt url
    }}
    pageInfo{hasNextPage endCursor}
  }
}`

const COMMENT_FIELDS = `
  id databaseId body createdAt diffHunk authorAssociation
  author{login avatarUrl __typename} pullRequestReview{id}
  reactionGroups{content reactors{totalCount}}
`

const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){
    nodes{
      id isResolved isOutdated path line startLine originalLine originalStartLine resolvedBy{login}
      comments(first:100){nodes{${COMMENT_FIELDS}} pageInfo{hasNextPage endCursor}}
    }
    pageInfo{hasNextPage endCursor}
  }}}
}`

const REVIEW_THREAD_COMMENTS_QUERY = `query($id:ID!,$endCursor:String){
  node(id:$id){... on PullRequestReviewThread{
    comments(first:100,after:$endCursor){nodes{${COMMENT_FIELDS}} pageInfo{hasNextPage endCursor}}
  }}
}`

const RESOLVE_THREAD_MUTATION = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`
const UNRESOLVE_THREAD_MUTATION = `mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`

const COMMITS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){commits(first:100,after:$endCursor){
    nodes{commit{
      oid messageHeadline committedDate url
      authors(first:1){nodes{name user{login}}}
      signature{isValid}
    }}
    pageInfo{hasNextPage endCursor}
  }}}
}`

const NO_PULL_REQUEST = /no pull requests found|could not find(?: a)? pull request/i
const NOT_FOUND = /not found|HTTP 404/i
const PR_LIST_FIELDS = "number,title,headRefName,baseRefName,author,state,isDraft,additions,deletions,updatedAt"
const ISSUE_FIELDS = "number,title,body,state,url,author,assignees,labels,updatedAt,createdAt,comments"
const ISSUE_LIST_FIELDS = "number,title,body,state,url,author,assignees,labels,updatedAt"
const PR_NUMBER = /\/pull\/(\d+)(?:\D|$)/

const repoArgs = (repository: string | null): ReadonlyArray<string> =>
  repository === null ? [] : ["--repo", repository]

const submitFlag = (kind: ReviewSubmitKind): string =>
  kind === "approve" ? "--approve" : kind === "request-changes" ? "--request-changes" : "--comment"

const mergeFlag = (method: PrMergeMethod): string =>
  method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge"

const decode = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.runFold("", (output, chunk) => output + chunk))

const execute = (
  cwd: string | null,
  args: ReadonlyArray<string>,
  stdin?: string,
  environment?: Readonly<Record<string, string>>
): Effect.Effect<string, GitHubApiError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = Command.make("gh", ...args)
      const located = cwd === null ? base : base.pipe(Command.workingDirectory(cwd))
      const fed = stdin === undefined ? located : located.pipe(Command.feed(stdin))
      const command = fed.pipe(Command.env({
        ...withMacCliPath(process.env),
        ...environment
      }))
      const child = yield* command.pipe(Command.start)
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [decode(child.stdout), decode(child.stderr), child.exitCode],
        { concurrency: 3 }
      )
      if (exitCode !== 0) {
        const message = stderr.trim() || stdout.trim() || `gh exited ${exitCode}`
        return yield* Effect.fail(new GitHubApiError({
          reason: NO_PULL_REQUEST.test(message) || NOT_FOUND.test(message)
            ? "not-found"
            : "unavailable",
          message
        }))
      }
      return stdout.trim()
    })
  ).pipe(
    Effect.catchAll((error) =>
      error instanceof GitHubApiError
        ? Effect.fail(error)
        : Effect.fail(new GitHubApiError({ reason: "unavailable", message: "GitHub CLI failed." }))
    )
  )

const json = (
  cwd: string | null,
  args: ReadonlyArray<string>,
  stdin?: string
): Effect.Effect<unknown, GitHubApiError, CommandExecutor.CommandExecutor> =>
  execute(cwd, args, stdin).pipe(
    Effect.flatMap((output) =>
      Effect.try({
        try: () => JSON.parse(output) as unknown,
        catch: () => new GitHubApiError({
          reason: "unavailable",
          message: "GitHub CLI returned invalid JSON."
        })
      })
    )
  )

const slugParts = (slug: string): readonly [string, string] => {
  const [owner, repo, extra] = slug.split("/")
  if (!(owner && repo) || extra !== undefined) {
    throw new GitHubApiError({ reason: "validation", message: "The GitHub repository is invalid." })
  }
  return [owner, repo]
}

type Json = Record<string, unknown>

const records = (value: unknown): ReadonlyArray<Json> =>
  Array.isArray(value) ? value.map(jsonRecord) : []

const connectionPage = (
  value: unknown,
  resource: string
): { readonly nodes: ReadonlyArray<Json>; readonly next: string | null } => {
  const connection = jsonRecord(value)
  const pageInfo = jsonRecord(connection.pageInfo)
  if (typeof pageInfo.hasNextPage !== "boolean") {
    throw new GitHubApiError({
      reason: "unavailable",
      message: `GitHub CLI returned invalid ${resource} pagination.`
    })
  }
  if (!pageInfo.hasNextPage) return { nodes: records(connection.nodes), next: null }
  if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0) {
    throw new GitHubApiError({
      reason: "unavailable",
      message: `GitHub CLI returned invalid ${resource} pagination.`
    })
  }
  return { nodes: records(connection.nodes), next: pageInfo.endCursor }
}

const reviewThreadsConnection = (raw: unknown): Json => {
  const data = jsonRecord(jsonRecord(raw).data)
  const repository = jsonRecord(data.repository)
  const pullRequest = jsonRecord(repository.pullRequest)
  return jsonRecord(pullRequest.reviewThreads)
}

const threadCommentsConnection = (raw: unknown): Json => {
  const data = jsonRecord(jsonRecord(raw).data)
  return jsonRecord(jsonRecord(data.node).comments)
}

const commitsConnection = (raw: unknown): Json => {
  const data = jsonRecord(jsonRecord(raw).data)
  const repository = jsonRecord(data.repository)
  const pullRequest = jsonRecord(repository.pullRequest)
  return jsonRecord(pullRequest.commits)
}

const paginatedGraphql = (
  cwd: string | null,
  fields: ReadonlyArray<string>,
  query: string
): Effect.Effect<ReadonlyArray<unknown>, GitHubApiError, CommandExecutor.CommandExecutor> =>
  json(cwd, [
    "api", "graphql", "--paginate", "--slurp",
    ...fields.flatMap((field) => ["-F", field]),
    "-f", `query=${query}`
  ]).pipe(
    Effect.flatMap((raw) =>
      Array.isArray(raw)
        ? Effect.succeed(raw)
        : Effect.fail(new GitHubApiError({
            reason: "unavailable",
            message: "GitHub CLI returned invalid paginated GraphQL data."
          }))
    )
  )

const reviewThreads = (
  cwd: string | null,
  owner: string,
  repo: string,
  number: number
): Effect.Effect<ReturnType<typeof mapReviewThreads>, GitHubApiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const pages = yield* paginatedGraphql(
      cwd,
      [`owner=${owner}`, `repo=${repo}`, `number=${number}`],
      REVIEW_THREADS_QUERY
    )
    const threads = pages.flatMap((page) => connectionPage(
      reviewThreadsConnection(page),
      "review threads"
    ).nodes)
    const complete: Json[] = []
    for (const thread of threads) {
      const first = connectionPage(thread.comments, "review comments")
      const comments = [...first.nodes]
      if (first.next) {
        const commentPages = yield* paginatedGraphql(
          cwd,
          [`id=${String(thread.id)}`, `endCursor=${first.next}`],
          REVIEW_THREAD_COMMENTS_QUERY
        )
        for (const page of commentPages) {
          comments.push(...connectionPage(threadCommentsConnection(page), "review comments").nodes)
        }
      }
      complete.push({ ...thread, comments: { nodes: comments } })
    }
    return mapReviewThreads(complete)
  })

const commitEvidence = (
  cwd: string | null,
  owner: string,
  repo: string,
  number: number
): Effect.Effect<ReadonlyArray<Json>, GitHubApiError, CommandExecutor.CommandExecutor> =>
  paginatedGraphql(
    cwd,
    [`owner=${owner}`, `repo=${repo}`, `number=${number}`],
    COMMITS_QUERY
  ).pipe(
    Effect.map((pages) => pages.flatMap((page) =>
      connectionPage(commitsConnection(page), "commits").nodes.map((node) => jsonRecord(node.commit))
    ))
  )

const pullRequestFiles = (
  cwd: string | null,
  repository: string,
  number: number
): Effect.Effect<ReadonlyArray<unknown>, GitHubApiError, CommandExecutor.CommandExecutor> =>
  json(cwd, [
    "api", `repos/${repository}/pulls/${number}/files`, "--paginate", "--slurp"
  ]).pipe(Effect.map((raw) => Array.isArray(raw) ? raw.flat() : []))

const prView = (
  cwd: string | null,
  repository: string | null,
  number: number
): Effect.Effect<PullRequest, GitHubApiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const repositoryArgs = repoArgs(repository)
    const raw = yield* json(cwd, ["pr", "view", String(number), ...repositoryArgs, "--json", PR_FIELDS])
    const [owner, repo] = repository
      ? slugParts(repository.replace(/^github\.com\//, ""))
      : yield* execute(cwd, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).pipe(
          Effect.map(slugParts)
        )
    const threads = yield* reviewThreads(cwd, owner, repo, number)
    const commits = yield* commitEvidence(cwd, owner, repo, number)
    const files = yield* pullRequestFiles(cwd, `${owner}/${repo}`, number)
    return { ...mapPrView({ ...jsonRecord(raw), commits, files }), reviewThreads: threads }
  })

const list = <A>(
  cwd: string | null,
  kind: "pr" | "issue",
  repository: string | null,
  fields: string,
  options: { readonly mine: boolean; readonly search: string },
  map: (value: unknown) => A
): Effect.Effect<ReadonlyArray<A>, GitHubApiError, CommandExecutor.CommandExecutor> =>
  json(cwd, [
    kind, "list", ...repoArgs(repository), "--state", "open", "--limit", "1000",
    ...(options.mine ? [kind === "pr" ? "--author" : "--assignee", "@me"] : []),
    ...(options.search.trim() ? ["--search", options.search.trim()] : []),
    "--json", fields
  ]).pipe(Effect.map((raw) => records(raw).map(map)))

const prForBranch = (
  cwd: string | null,
  repository: string,
  branch: string
): Effect.Effect<number | null, GitHubApiError, CommandExecutor.CommandExecutor> =>
  json(cwd, [
    "pr", "list", ...repoArgs(cwd === null ? repository : null), "--state", "open",
    "--head", branch, "--limit", "100", "--json", "number,headRefName,headRepository"
  ]).pipe(
    Effect.map((raw) => records(raw).find((value) => {
      const head = jsonRecord(value.headRepository)
      return value.headRefName === branch && head.nameWithOwner === repository
    })?.number),
    Effect.map((number) => typeof number === "number" ? number : null)
  )

const issueView = (
  cwd: string | null,
  repository: string | null,
  number: number
): Effect.Effect<Issue, GitHubApiError, CommandExecutor.CommandExecutor> =>
  json(cwd, ["issue", "view", String(number), ...repoArgs(repository), "--json", ISSUE_FIELDS]).pipe(
    Effect.map(mapIssue)
  )

const writeJson = (
  cwd: string | null,
  args: ReadonlyArray<string>,
  body: unknown
): Effect.Effect<void, GitHubApiError, CommandExecutor.CommandExecutor> =>
  execute(cwd, args, JSON.stringify(body)).pipe(Effect.asVoid)

const slugAt = (cwd: string): Effect.Effect<string, GitHubApiError, CommandExecutor.CommandExecutor> =>
  execute(cwd, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])

const repositoryMetadata = (
  cwd: string | null,
  repository: string
): Effect.Effect<Record<string, unknown>, GitHubApiError, CommandExecutor.CommandExecutor> =>
  json(cwd, ["api", `repos/${repository}`]).pipe(Effect.map(jsonRecord))

const reviewPayload = (input: {
  readonly commitSha: string
  readonly body: string
  readonly comments: ReadonlyArray<{
    readonly path: string
    readonly line: number
    readonly startLine: number | null
    readonly body: string
  }>
}) => ({
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
})

const repositoryBySlug = (cwd: string | null, repository: string) =>
      Effect.gen(function* () {
        const raw = yield* repositoryMetadata(cwd, repository)
        const [owner, name] = slugParts(repository)
        if (typeof raw.id !== "number" || typeof raw.node_id !== "string") {
          return yield* Effect.fail(new GitHubApiError({
            reason: "unavailable",
            message: "GitHub CLI returned invalid repository metadata."
          }))
        }
        return {
          id: String(raw.id), nodeId: raw.node_id, owner, name, fullName: repository,
          installationId: undefined
        }
      })

const prCheckoutForRepo = (cwd: string | null, number: number, repository: string | null) =>
      Effect.gen(function* () {
        const raw = jsonRecord(yield* json(cwd, [
          "pr", "view", String(number), ...repoArgs(repository), "--json", "headRefName,headRefOid,headRepository"
        ]))
        const headRepository = jsonRecord(raw.headRepository)
        const fullName = headRepository.nameWithOwner
        if (typeof fullName !== "string" || typeof raw.headRefName !== "string" || typeof raw.headRefOid !== "string") {
          return yield* Effect.fail(new GitHubApiError({ reason: "validation", message: "GitHub did not return a fetchable pull-request head." }))
        }
        const metadata = yield* repositoryMetadata(cwd, fullName)
        if (typeof metadata.id !== "number" || typeof metadata.clone_url !== "string") {
          return yield* Effect.fail(new GitHubApiError({ reason: "validation", message: "GitHub did not return a fetchable pull-request repository." }))
        }
        return {
          repositoryId: String(metadata.id), fullName, ref: raw.headRefName, sha: raw.headRefOid,
          cloneUrl: metadata.clone_url, sshUrl: typeof metadata.ssh_url === "string" ? metadata.ssh_url : null
        }
      })

const TEAM_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/
// Enterprise Managed User logins include an underscore before the enterprise shortcode.
const USER_LOGIN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/
const REPOSITORY_NAME = /^[a-zA-Z0-9_.-]+$/
const teamValidation = (message: string) => new GitHubApiError({ reason: "validation", message })

const validateTeam = (organization: string, slug: string): void => {
  if (!TEAM_NAME.test(organization) || !TEAM_NAME.test(slug)) {
    throw teamValidation("Choose a valid GitHub organization team.")
  }
}

const validateTeamPr = (repository: string, number: number): void => {
  const [owner, name] = slugParts(repository)
  if (!USER_LOGIN.test(owner) || !REPOSITORY_NAME.test(name) || !Number.isSafeInteger(number) || number < 1) {
    throw teamValidation("Choose a valid GitHub pull request.")
  }
}

// Never send raw CLI stderr (which can contain credentials) across RPC.
const teamCliError = (error: GitHubApiError): GitHubApiError => {
  if (error.reason === "validation") return error
  const message = error.message
  if (/rate limit|retry-after|secondary rate/i.test(message)) {
    return new GitHubApiError({ reason: "unavailable", message: "GitHub CLI rate limit reached. Wait for the GitHub limit to reset before refreshing; no automatic retry is running." })
  }
  if (/SSO|SAML/i.test(message)) {
    return new GitHubApiError({ reason: "repository-access", message: "Authorize your GitHub CLI credentials for this organization's SSO, then refresh." })
  }
  if (/403|404|scope|forbidden|not found/i.test(message)) {
    return new GitHubApiError({ reason: "repository-access", message: "GitHub CLI cannot access this team or repository. Check organization membership, read:org/repository permissions and SSO authorization, then refresh." })
  }
  return new GitHubApiError({ reason: "unavailable", message: "GitHub CLI could not load team work. Run gh auth login --hostname github.com or check your connection, then refresh." })
}

/** Snapshot CLI credentials privately for one operation: switching accounts mid-read/write cannot change its identity. */
const withTeamAccount = <A>(
  expectedAccountId: string | null,
  operation: (account: GitHubCliAccount, token: string) => Effect.Effect<A, GitHubApiError, CommandExecutor.CommandExecutor>
): Effect.Effect<A, GitHubApiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const token = yield* execute(null, ["auth", "token", "--hostname", "github.com"])
    if (!token || /\s/.test(token)) return yield* Effect.fail(teamValidation("Authenticate GitHub CLI on github.com, then refresh."))
    const executor = yield* CommandExecutor.CommandExecutor
    const pinned = CommandExecutor.makeExecutor((command) => executor.start(command.pipe(Command.env({
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GH_HOST: "github.com",
      GH_DEBUG: "",
    }))))
    return yield* Effect.gen(function* () {
      const user = jsonRecord(yield* json(null, ["api", "user", "--hostname", "github.com"]))
      if (typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id < 1 ||
          typeof user.login !== "string" || !USER_LOGIN.test(user.login)) {
        return yield* Effect.fail(teamValidation("GitHub CLI returned an invalid account. Authenticate again, then refresh."))
      }
      const account = { id: String(user.id), login: user.login }
      if (expectedAccountId !== null && account.id !== expectedAccountId) {
        return yield* Effect.fail(teamValidation("The GitHub CLI account changed. Refresh teams before opening or changing a pull request."))
      }
      return yield* operation(account, token)
    }).pipe(Effect.provideService(CommandExecutor.CommandExecutor, pinned))
  }).pipe(
    Effect.catchAllDefect((error) => Effect.fail(error instanceof GitHubApiError ? error : teamValidation("GitHub CLI returned invalid team data. Refresh to retry."))),
    Effect.mapError(teamCliError)
  )

const teamApi = (endpoint: string, fields: ReadonlyArray<string> = []) =>
  json(null, ["api", endpoint, "--hostname", "github.com", "--method", "GET", ...fields.flatMap((field) => ["-f", field])])

const teamPages = (endpoint: string) =>
  json(null, ["api", endpoint, "--hostname", "github.com", "--method", "GET", "-f", "per_page=100", "--paginate", "--slurp"]).pipe(
    Effect.flatMap((raw) => Array.isArray(raw) && raw.every(Array.isArray)
      ? Effect.succeed(raw.flat().map(jsonRecord))
      : Effect.fail(teamValidation("GitHub CLI returned invalid team pagination. Refresh to retry.")))
  )

const discoverTeams = () => teamPages("user/teams").pipe(Effect.flatMap((rows) => Effect.try({
  try: () => rows.flatMap((row): GitHubTeam[] => {
    // Enterprise-level teams are not organization queues.
    if (row.type === "enterprise") return []
    const organization = jsonRecord(row.organization).login
    if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || typeof organization !== "string" ||
        typeof row.slug !== "string" || typeof row.name !== "string") throw teamValidation("GitHub CLI returned invalid team metadata.")
    validateTeam(organization, row.slug)
    return [{ id: String(row.id), organization, slug: row.slug, name: row.name }]
  }).sort((a, b) => `${a.organization}/${a.name}`.localeCompare(`${b.organization}/${b.name}`)),
  catch: (error) => error instanceof GitHubApiError ? error : teamValidation("GitHub CLI returned invalid teams."),
})))

const searchItem = (row: Json, viewer: string): PullRequestListItem => {
  const url = typeof row.html_url === "string" ? row.html_url : ""
  const match = /^https:\/\/github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)\/pull\/(\d+)$/.exec(url)
  if (!match || typeof row.number !== "number" || row.number !== Number(match[2]) ||
      typeof row.title !== "string" || typeof row.updated_at !== "string" || typeof row.draft !== "boolean") {
    throw teamValidation("GitHub CLI returned an invalid PR row. Refresh to retry.")
  }
  return mapPullRequestListItem({ ...row, author: row.user, isDraft: row.draft }, match[1]!, viewer)
}

const searchPage = (q: string, page: number, viewer: string) =>
  teamApi("search/issues", ["per_page=100", `page=${page}`, "sort=updated", "order=desc", `q=${q}`]).pipe(
    Effect.flatMap((raw) => Effect.try({
      try: () => {
        const result = jsonRecord(raw)
        if (typeof result.total_count !== "number" || !Number.isSafeInteger(result.total_count) || result.total_count < 0 ||
            typeof result.incomplete_results !== "boolean" || !Array.isArray(result.items)) {
          throw teamValidation("GitHub CLI returned invalid search pagination. Refresh to retry.")
        }
        return { total: result.total_count, incomplete: result.incomplete_results, prs: result.items.map((row) => searchItem(jsonRecord(row), viewer)) }
      },
      catch: (error) => error instanceof GitHubApiError ? error : teamValidation("GitHub CLI returned invalid search data. Refresh to retry."),
    }))
  )

type SearchTask = { from: number; to: number; page: number }
type SearchProgress = {
  tasks: Map<string, SearchTask>
  prs: Map<string, PullRequestListItem>
  // Historical rows stay visible, but only this attempt can satisfy the search count.
  observed: Map<string, PullRequestListItem>
  // Keep a historical ceiling warning until a fresh attempt verifies completeness.
  previousCeiling: boolean
  counts: Map<string, number>
  completed: Set<string>
  ceiling: boolean
}
type QueueProgress = Map<string, SearchProgress>
const hasUnfinishedSearches = (progress: QueueProgress | undefined) =>
  progress !== undefined && [...progress.values()].some((search) => search.tasks.size > 0)
const taskKey = (task: SearchTask) => `${task.from}/${task.to}/${task.page}`
const prKey = (pr: PullRequestListItem) => `${pr.repository.toLowerCase()}#${pr.number}`
const moveWorkToEnd = <T>(queue: Map<string, T>, key: string) => {
  const value = queue.get(key)
  if (value !== undefined) { queue.delete(key); queue.set(key, value) }
}
const newSearchProgress = (): SearchProgress => {
  const task = { from: 0, to: Math.floor(Date.now() / 1000), page: 1 }
  return { tasks: new Map([[taskKey(task), task]]), prs: new Map(), observed: new Map(), previousCeiling: false, counts: new Map(), completed: new Set(), ceiling: false }
}

const splitSearchRange = (progress: SearchProgress, task: SearchTask): void => {
  for (const [key, pending] of progress.tasks) {
    if (pending.from === task.from && pending.to === task.to) progress.tasks.delete(key)
  }
  progress.counts.delete(`${task.from}/${task.to}`)
  const middle = Math.floor((task.from + task.to) / 2)
  for (const [from, to] of [[task.from, middle], [middle + 1, task.to]] as const) {
    const child = { from, to, page: 1 }
    progress.tasks.set(taskKey(child), child)
  }
}

const rememberSearchPage = (progress: SearchProgress, task: SearchTask, result: {
  total: number; incomplete: boolean; prs: PullRequestListItem[]
}): void => {
  for (const pr of result.prs) {
    progress.prs.set(prKey(pr), pr)
    progress.observed.set(prKey(pr), pr)
  }
  const range = `${task.from}/${task.to}`
  if (result.total > 1000 && task.from < task.to) {
    splitSearchRange(progress, task)
    return
  }
  progress.counts.set(range, result.total)
  if (!result.incomplete) {
    progress.tasks.delete(taskKey(task))
    progress.completed.add(taskKey(task))
  }
  if (task.page === 1) {
    for (let page = 2; page <= Math.ceil(Math.min(result.total, 1000) / 100); page++) {
      const next = { ...task, page }
      if (!progress.completed.has(taskKey(next))) progress.tasks.set(taskKey(next), next)
    }
  }
  if (result.total > 1000) progress.ceiling = true
}

const recordSearchCooldown = (error: GitHubApiError, cooldowns: Map<string, number>, accountId: string) => Effect.gen(function* () {
  const limit = yield* teamApi("rate_limit").pipe(Effect.either)
  const search = limit._tag === "Right" ? jsonRecord(jsonRecord(jsonRecord(limit.right).resources).search) : {}
  const retryAfter = /retry-after[=: ]+(\d+)/i.exec(error.message)?.[1]
  const reset = search.remaining === 0 && typeof search.reset === "number" && Number.isFinite(search.reset) && search.reset * 1000 > Date.now()
    ? search.reset * 1000 : Date.now() + 60_000
  cooldowns.set(accountId, Math.max(reset, Date.now() + (retryAfter ? Number(retryAfter) * 1000 : 0)))
})

const retryMissingSearch = (progress: SearchProgress, warnings: string[]): void => {
  const expected = [...progress.counts.values()].reduce((sum, count) => sum + count, 0)
  if (progress.tasks.size === 0 && !progress.ceiling && progress.observed.size < expected) {
    const retry = { from: 0, to: Math.floor(Date.now() / 1000), page: 1 }
    progress.counts.clear()
    progress.completed.clear()
    progress.observed.clear()
    progress.tasks.set(taskKey(retry), retry)
    warnings.push("GitHub returned fewer PRs than its search count. This queue is incomplete; refresh to retry.")
  } else if (progress.tasks.size === 0 && !progress.ceiling) {
    progress.prs = new Map(progress.observed)
    progress.previousCeiling = false
  }
}

const searchTeamPrs = (
  query: string, viewer: string, progress: SearchProgress, warnings: string[],
  cooldowns: Map<string, number>, accountId: string
) => Effect.gen(function* () {
  const attempted = new Set<string>()
  let limited = false
  let processed = false
  const date = (seconds: number) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z")
  for (;;) {
    const entry = [...progress.tasks].find(([key]) => !attempted.has(key))
    if (!entry) break
    const [key, task] = entry
    attempted.add(key)
    const q = `${query} created:${date(task.from)}..${date(task.to)}`
    const result = yield* searchPage(q, task.page, viewer).pipe(Effect.either)
    if (result._tag === "Left") {
      warnings.push(teamCliError(result.left).message)
      if (/rate limit|retry-after|secondary rate/i.test(result.left.message)) {
        limited = true
        yield* recordSearchCooldown(result.left, cooldowns, accountId)
        break
      }
      processed = true
      moveWorkToEnd(progress.tasks, key)
      continue
    }
    processed = true
    rememberSearchPage(progress, task, result.right)
    moveWorkToEnd(progress.tasks, key)
    if (result.right.incomplete) warnings.push("GitHub timed out part of the search. This queue is incomplete; Refresh resumes missing results.")
  }
  retryMissingSearch(progress, warnings)
  return { limited, processed }
})

type DiscoveryCache = Map<string, { rows: ReadonlyArray<Json>; at: number }>
const cachedTeamPages = (accountId: string, endpoint: string, refresh: boolean, cache: DiscoveryCache) =>
  Effect.gen(function* () {
    const key = `${accountId}/${endpoint}`
    const cached = cache.get(key)
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.rows
    const rows = yield* teamPages(endpoint)
    cache.set(key, { rows, at: Date.now() })
    return rows
  })

const repositoryQueries = (rows: ReadonlyArray<Json>, qualifier = "") => rows.map((row) => {
  if (typeof row.full_name !== "string") throw teamValidation("GitHub CLI returned an invalid team repository.")
  validateTeamPr(row.full_name, 1)
  return `is:pr is:open repo:${row.full_name}${qualifier}`
})

const teamQueries = (
  account: GitHubCliAccount, organization: string, slug: string, queue: GitHubTeamQueue,
  refresh: boolean, discoveryCache: DiscoveryCache, warnings: string[]
) => Effect.gen(function* () {
  const endpoint = `orgs/${organization}/repos`
  const orgRepos = queue === "repositories" ? []
    : yield* cachedTeamPages(account.id, endpoint, refresh, discoveryCache).pipe(Effect.catchAll((error) => Effect.sync(() => {
        warnings.push(`Could not verify GitHub's repository search scope. Results may be incomplete. ${teamCliError(error).message}`)
        return discoveryCache.get(`${account.id}/${endpoint}`)?.rows ?? []
      })))
  if (queue === "reviews") {
    const qualifier = ` team-review-requested:${organization}/${slug}`
    return { queries: orgRepos.length > 4000 ? repositoryQueries(orgRepos, qualifier)
      : [`is:pr is:open org:${organization}${qualifier}`], authors: null }
  }
  const rows = yield* cachedTeamPages(account.id, `orgs/${organization}/teams/${slug}/${queue === "authored" ? "members" : "repos"}`, refresh, discoveryCache)
  if (queue === "repositories") return { queries: repositoryQueries(rows), authors: null }
  const members = rows.map((row) => {
    if (typeof row.login !== "string" || !USER_LOGIN.test(row.login)) throw teamValidation("GitHub CLI returned an invalid team member.")
    return row.login
  })
  // One repository search plus exact author filtering avoids a members × repositories request explosion.
  return { queries: orgRepos.length > 4000 ? repositoryQueries(orgRepos)
    : members.map((login) => `is:pr is:open org:${organization} author:${login}`),
    authors: orgRepos.length > 4000 ? new Set(members.map((login) => login.toLowerCase())) : null }
})

const resumeSearchQueue = (currentQueries: ReadonlyArray<string>, previous: QueueProgress | undefined, refresh: boolean): QueueProgress => {
  const queries = new Set(currentQueries)
  const progress: QueueProgress = new Map([...(previous ?? [])].filter(([query, search]) => queries.has(query) && search.tasks.size > 0))
  for (const query of queries) {
    if (progress.has(query)) continue
    const old = previous?.get(query)
    const search = old && !refresh ? old : newSearchProgress()
    if (old && refresh) {
      search.prs = new Map(old.prs)
      search.previousCeiling = old.ceiling || old.previousCeiling
    }
    progress.set(query, search)
  }
  return progress
}

const advanceSearchQueue = (progress: QueueProgress, account: GitHubCliAccount, warnings: string[], cooldowns: Map<string, number>) =>
  Effect.gen(function* () {
    // Snapshot iteration lets partially successful queries move behind untouched work.
    const pendingSearches = [...progress].filter(([, search]) => search.tasks.size > 0)
    for (const [query, searchProgress] of pendingSearches) {
      if ((cooldowns.get(account.id) ?? 0) > Date.now()) {
        warnings.push("GitHub CLI rate limit reached. Wait for the quota reset, then Refresh resumes missing results.")
        break
      }
      const result = yield* searchTeamPrs(query, account.login, searchProgress, warnings, cooldowns, account.id)
      if (result.processed || !result.limited) moveWorkToEnd(progress, query)
      if (result.limited) break
    }
  })

const teamQueuePrs = (
  account: GitHubCliAccount,
  organization: string,
  slug: string,
  queue: GitHubTeamQueue,
  refresh: boolean,
  discoveryCache: DiscoveryCache,
  queues: Map<string, QueueProgress>,
  cooldowns: Map<string, number>
): Effect.Effect<GitHubTeamPrResult, GitHubApiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    validateTeam(organization, slug)
    if (!["reviews", "authored", "repositories"].includes(queue)) return yield* Effect.fail(teamValidation("Choose a valid team queue."))
    const membership = jsonRecord(yield* teamApi(`orgs/${organization}/teams/${slug}/memberships/${account.login}`))
    if (membership.state !== "active") return yield* Effect.fail(teamValidation("You are no longer an active member of this team. Refresh teams."))
    const warnings: string[] = []
    const plan = yield* teamQueries(account, organization, slug, queue, refresh, discoveryCache, warnings)
    const key = `${account.id}/${organization.toLowerCase()}/${slug.toLowerCase()}/${queue}`
    const progress = resumeSearchQueue(plan.queries, queues.get(key), refresh)
    // Incomplete work intentionally has no TTL: quota reset must not restart completed pages.
    queues.set(key, progress)
    yield* advanceSearchQueue(progress, account, warnings, cooldowns)
    if (hasUnfinishedSearches(progress)) {
      warnings.push("Some searches are unfinished. Refresh resumes missing results without restarting completed pages.")
    }
    if ([...progress.values()].some((search) => search.ceiling || search.previousCeiling)) {
      warnings.push("Some PRs share the same creation second and exceed GitHub's search limit. This queue is incomplete.")
    }
    if (!hasUnfinishedSearches(progress)) queues.delete(key)
    const prs = [...progress.values()].flatMap((search) => [...search.prs.values()])
      .filter((pr) => plan.authors === null || plan.authors.has(pr.author.login.toLowerCase()))
    return {
      prs: [...new Map(prs.map((pr) => [prKey(pr), pr])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      warnings: [...new Set(warnings)],
    }
  })

const pruneRemovedTeamProgress = (
  accountId: string, teams: ReadonlyArray<GitHubTeam>, queues: Map<string, QueueProgress>, discoveryCache: DiscoveryCache
): void => {
  const memberships = new Set(teams.map((team) => `${accountId}/${team.organization.toLowerCase()}/${team.slug.toLowerCase()}`))
  for (const key of queues.keys()) {
    if (key.startsWith(`${accountId}/`) && !memberships.has(key.slice(0, key.lastIndexOf("/")))) queues.delete(key)
  }
  for (const key of discoveryCache.keys()) {
    const match = /^(\d+)\/orgs\/([^/]+)\/teams\/([^/]+)\//.exec(key)
    if (match?.[1] === accountId && !memberships.has(`${accountId}/${match[2]!.toLowerCase()}/${match[3]!.toLowerCase()}`)) discoveryCache.delete(key)
  }
}

export class GitHubCli extends Effect.Service<GitHubCli>()("@jingler/GitHubCli", {
  accessors: true,
  effect: Effect.sync(() => {
    const discoveryCache: DiscoveryCache = new Map()
    const queues = new Map<string, QueueProgress>()
    const cooldowns = new Map<string, number>()
    const accountLocks = new Map<string, ReturnType<typeof Effect.unsafeMakeSemaphore>>()
    const teamPrs = (input: { accountId: string; organization: string; teamSlug: string; queue: GitHubTeamQueue; refresh: boolean }) => {
      const lock = accountLocks.get(input.accountId) ?? Effect.unsafeMakeSemaphore(1)
      accountLocks.set(input.accountId, lock)
      // Search quotas are shared across an account's queues; serialize their progress updates too.
      return lock.withPermits(1)(withTeamAccount(input.accountId, (account) =>
        teamQueuePrs(account, input.organization, input.teamSlug, input.queue, input.refresh, discoveryCache, queues, cooldowns)))
    }
    return {
    teams: () => withTeamAccount(null, (account) => discoverTeams().pipe(Effect.map((teams) => {
      pruneRemovedTeamProgress(account.id, teams, queues, discoveryCache)
      return { account, teams }
    }))),
    teamPrs,
    teamPr: (input: { accountId: string; repository: string; number: number }) =>
      withTeamAccount(input.accountId, () => Effect.gen(function* () {
        validateTeamPr(input.repository, input.number)
        return yield* prView(null, `github.com/${input.repository}`, input.number)
      })),
    teamCheckout: (input: { accountId: string; repository: string; number: number }) =>
      withTeamAccount(input.accountId, (_account, token) => Effect.gen(function* () {
        validateTeamPr(input.repository, input.number)
        const repository = yield* repositoryBySlug(null, input.repository)
        const head = yield* prCheckoutForRepo(null, input.number, `github.com/${input.repository}`)
        validateTeamPr(head.fullName, input.number)
        return {
          repository, head,
          // Private main-process closure. Credentials never enter RPC or persisted session data.
          fetchBase: (cwd: string, branch: string) => fetchWithGitHubToken(cwd, repository.fullName,
            `+refs/heads/${branch}:refs/remotes/origin/${branch}`, token),
          fetchHead: (cwd: string, trackingRef: string) => fetchWithGitHubToken(cwd, head.fullName,
            `+refs/heads/${head.ref}:${trackingRef}`, token),
        }
      })),
    teamComment: (input: { accountId: string; repository: string; number: number; body: string }) =>
      withTeamAccount(input.accountId, () => Effect.gen(function* () {
        validateTeamPr(input.repository, input.number)
        if (!input.body.trim()) return yield* Effect.fail(teamValidation("Write a comment before posting."))
        yield* execute(null, ["pr", "comment", String(input.number), "--repo", `github.com/${input.repository}`, "--body-file", "-"], input.body)
      })),
    teamClose: (input: { accountId: string; repository: string; number: number }) =>
      withTeamAccount(input.accountId, () => Effect.gen(function* () {
        validateTeamPr(input.repository, input.number)
        yield* execute(null, ["pr", "close", String(input.number), "--repo", `github.com/${input.repository}`])
      })),
    teamMerge: (input: { accountId: string; repository: string; number: number; method: PrMergeMethod }) =>
      withTeamAccount(input.accountId, () => Effect.gen(function* () {
        validateTeamPr(input.repository, input.number)
        if (!["merge", "squash", "rebase"].includes(input.method)) return yield* Effect.fail(teamValidation("Choose a valid merge method."))
        yield* execute(null, ["pr", "merge", String(input.number), "--repo", `github.com/${input.repository}`, mergeFlag(input.method)])
      })),
    available: () =>
      execute(null, ["auth", "status", "--active", "--hostname", "github.com"]).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false)
      ),
    cloneRepository: (repository: string, destination: string) =>
      execute(null, ["repo", "clone", repository, destination], undefined, {
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        SSH_ASKPASS_REQUIRE: "never",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10"
      }).pipe(Effect.asVoid),
    repositories: () =>
      json(null, ["api", "user/repos", "--method", "GET", "-f", "per_page=100", "--paginate", "--slurp"]).pipe(
        Effect.map((raw) => (Array.isArray(raw) ? raw.flat() : []).flatMap((value) => {
          const repository = jsonRecord(value)
          return typeof repository.id === "number" && typeof repository.full_name === "string"
            ? [{ repositoryId: String(repository.id), fullName: repository.full_name }]
            : []
        }))
      ),
    repository: (cwd: string) => slugAt(cwd).pipe(Effect.flatMap((repository) => repositoryBySlug(cwd, repository))),
    prForBranch: (cwd: string, branch: string) =>
      Effect.flatMap(slugAt(cwd), (repository) => prForBranch(cwd, repository, branch)),
    prForBranchBySlug: (repository: string, branch: string) =>
      prForBranch(null, repository, branch),
    prForWorktree: (cwd: string) =>
      json(cwd, ["pr", "view", "--json", "number,state"]).pipe(
        Effect.map((raw) => {
          const pr = jsonRecord(raw)
          return String(pr.state).toUpperCase() === "OPEN" && typeof pr.number === "number"
            ? pr.number
            : null
        }),
        Effect.catchTag("GitHubApiError", (error) =>
          NO_PULL_REQUEST.test(error.message) ? Effect.succeed(null) : Effect.fail(error)
        )
      ),
    listPrs: (cwd: string, options: { readonly mine: boolean; readonly search: string }) =>
      list(cwd, "pr", null, PR_LIST_FIELDS, options, mapPrSummary),
    listPrsBySlug: (repository: string, options: { readonly mine: boolean; readonly search: string }) =>
      list(null, "pr", repository, PR_LIST_FIELDS, options, mapPrSummary),
    listInboxPrsBySlug: (repository: string) =>
      Effect.gen(function* () {
        const viewer = yield* execute(null, ["api", "user", "--jq", ".login"])
        const raw = yield* json(null, [
          "pr", "list", "--repo", repository, "--state", "open", "--limit", "1000",
          "--json", `${PR_LIST_FIELDS},labels,comments,assignees,reviewRequests`
        ])
        return records(raw).map((value) => mapPullRequestListItem(value, repository, viewer))
      }),
    listIssues: (cwd: string, options: { readonly mine: boolean; readonly search: string }) =>
      list(cwd, "issue", null, ISSUE_LIST_FIELDS, options, mapIssueSummary),
    listIssuesBySlug: (repository: string, options: { readonly mine: boolean; readonly search: string }) =>
      list(null, "issue", repository, ISSUE_LIST_FIELDS, options, mapIssueSummary),
    issueView: (cwd: string, number: number) => issueView(cwd, null, number),
    prState: (cwd: string, number: number): Effect.Effect<SessionPrStatus | null, GitHubApiError, CommandExecutor.CommandExecutor> =>
      json(cwd, [
        "pr", "view", String(number), "--json", "state,isDraft,mergedAt,statusCheckRollup"
      ]).pipe(Effect.map((raw) => mapPrState(raw, mapPrView(raw).checks))),
    prHeadSha: (cwd: string, number: number) =>
      execute(cwd, ["pr", "view", String(number), "--json", "headRefOid", "--jq", ".headRefOid"]),
    prView: (cwd: string, number: number) => prView(cwd, null, number),
    prViewBySlug: (repository: string, number: number) => prView(null, repository, number),
    prFiles: (cwd: string, number: number): Effect.Effect<ReadonlyArray<PrFileChange>, GitHubApiError, CommandExecutor.CommandExecutor> =>
      Effect.gen(function* () {
        const repository = yield* slugAt(cwd)
        return mapApiFiles(yield* pullRequestFiles(cwd, repository, number))
      }),
    prDiff: (cwd: string, number: number) => execute(cwd, ["pr", "diff", String(number)]),
    prCheckout: (cwd: string, number: number) => prCheckoutForRepo(cwd, number, null),
    prCreate: (cwd: string, input: { readonly title: string; readonly body: string; readonly base: string; readonly draft: boolean }) =>
      execute(cwd, [
        "pr", "create",
        ...(input.title.trim() === "" && input.body.trim() === ""
          ? ["--fill"]
          : ["--title", input.title, "--body-file", "-"]),
        "--base", input.base,
        ...(input.draft ? ["--draft"] : [])
      ], input.title.trim() === "" && input.body.trim() === "" ? undefined : input.body).pipe(Effect.flatMap((output) => {
        const number = Number(PR_NUMBER.exec(output)?.[1])
        return Number.isSafeInteger(number) && number > 0
          ? Effect.succeed(number)
          : Effect.fail(new GitHubApiError({ reason: "unavailable", message: "The pull request was created but GitHub CLI did not return its number." }))
      })),
    prCreateBySlug: (repository: string, branch: string, input: { readonly title: string; readonly body: string; readonly base: string; readonly draft: boolean }) =>
      json(null, ["api", "-X", "POST", `repos/${repository}/pulls`, "--input", "-"], JSON.stringify({
        title: input.title, body: input.body, head: `${slugParts(repository)[0]}:${branch}`, base: input.base, draft: input.draft
      })).pipe(Effect.flatMap((raw) => {
        const number = jsonRecord(raw).number
        return typeof number === "number"
          ? Effect.succeed(number)
          : Effect.fail(new GitHubApiError({ reason: "unavailable", message: "The pull request was created but GitHub CLI did not return its number." }))
      })),
    prUpdate: (cwd: string, number: number, input: { readonly title: string; readonly body: string }) =>
      execute(cwd, ["pr", "edit", String(number), "--title", input.title, "--body-file", "-"], input.body).pipe(Effect.asVoid),
    prUpdateBySlug: (repository: string, number: number, input: { readonly title: string; readonly body: string }) =>
      execute(null, ["pr", "edit", String(number), "--repo", repository, "--title", input.title, "--body-file", "-"], input.body).pipe(Effect.asVoid),
    prComment: (cwd: string, number: number, body: string) =>
      execute(cwd, ["pr", "comment", String(number), "--body-file", "-"], body).pipe(Effect.asVoid),
    prCommentBySlug: (repository: string, number: number, body: string) =>
      execute(null, ["pr", "comment", String(number), "--repo", repository, "--body-file", "-"], body).pipe(Effect.asVoid),
    prCloseBySlug: (repository: string, number: number) =>
      execute(null, ["pr", "close", String(number), "--repo", repository]).pipe(Effect.asVoid),
    prReviewComments: (cwd: string, number: number, input: Parameters<typeof reviewPayload>[0]) =>
      Effect.gen(function* () {
        const repository = yield* slugAt(cwd)
        yield* writeJson(cwd, ["api", "-X", "POST", `repos/${repository}/pulls/${number}/reviews`, "--input", "-"], reviewPayload(input))
      }),
    prReview: (cwd: string, number: number, kind: ReviewSubmitKind, body: string) =>
      execute(cwd, ["pr", "review", String(number), submitFlag(kind), "--body-file", "-"], body).pipe(Effect.asVoid),
    resolveThread: (cwd: string, threadId: string, resolved: boolean) =>
      execute(cwd, [
        "api", "graphql", "-f", `query=${resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION}`,
        "-F", `id=${threadId}`
      ]).pipe(Effect.asVoid),
    replyToThread: (cwd: string, number: number, commentId: number, body: string) =>
      Effect.gen(function* () {
        const repository = yield* slugAt(cwd)
        yield* writeJson(cwd, ["api", "-X", "POST", `repos/${repository}/pulls/${number}/comments/${commentId}/replies`, "--input", "-"], { body })
      }),
    prMerge: (cwd: string, number: number, method: PrMergeMethod = "merge") =>
      execute(cwd, ["pr", "merge", String(number), mergeFlag(method)]).pipe(Effect.asVoid),
    prMergeBySlug: (repository: string, number: number, method: PrMergeMethod = "merge") =>
      execute(null, ["pr", "merge", String(number), "--repo", repository, mergeFlag(method)]).pipe(Effect.asVoid),
    prUpdateBranch: (cwd: string, number: number) =>
      execute(cwd, ["pr", "update-branch", String(number)]).pipe(Effect.asVoid),
    prReady: (cwd: string, number: number) =>
      execute(cwd, ["pr", "ready", String(number)]).pipe(Effect.asVoid),
    issueComment: (cwd: string, number: number, body: string) =>
      execute(cwd, ["issue", "comment", String(number), "--body-file", "-"], body).pipe(Effect.asVoid),
    closeIssue: (cwd: string, number: number) =>
      execute(cwd, ["issue", "close", String(number)]).pipe(Effect.asVoid),
    inbox: () =>
      Effect.gen(function* () {
        const raw = yield* json(null, [
          "api", "graphql", "--paginate", "--slurp", "-f", `query=${INBOX_QUERY}`
        ])
        if (!Array.isArray(raw)) return []
        const pages = raw.map(jsonRecord)
        const viewerLogin = jsonRecord(jsonRecord(pages[0]?.data).viewer).login
        return pages.flatMap((page) => {
          const nodes = jsonRecord(jsonRecord(page.data).search).nodes
          if (!Array.isArray(nodes)) return []
          return nodes.flatMap((value): ReadonlyArray<PullRequestListItem> => {
            const row = jsonRecord(value)
            const repository = jsonRecord(row.repository).nameWithOwner
            if (typeof repository !== "string") return []
            const reviewRequests = jsonRecord(row.reviewRequests).nodes
            return [mapPullRequestListItem({
              ...row,
              assignees: jsonRecord(row.assignees).nodes,
              comments: jsonRecord(row.comments).totalCount,
              labels: jsonRecord(row.labels).nodes,
              reviewRequests: Array.isArray(reviewRequests)
                ? reviewRequests.map((request) => jsonRecord(jsonRecord(request).requestedReviewer))
                : []
            }, repository, typeof viewerLogin === "string" ? viewerLogin : null)]
          })
        })
      })
    }
  })
}) {}
