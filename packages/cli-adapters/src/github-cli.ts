import type {
  Issue,
  IssueListItem,
  PrFileChange,
  PrMergeMethod,
  PullRequest,
  PullRequestListItem,
  ReviewSubmitKind,
  SessionPrStatus,
  GitHubCliAccount,
  GitHubTeam,
  GitHubTeamQueue,
  HomeGitHub,
  PrSearchFilters,
  PrSearchPage
} from "@jingler/core"
import { GitHubApiError } from "@jingler/core"
import { Command, CommandExecutor } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, Stream } from "effect"
import { MAX_IN_FLIGHT, makeRateGate } from "./github-rate-gate.js"
import { PR_PAGE_SIZE, RATE_LIMIT_FLOOR, buildPrSearchQuery, scopeWarning, type TeamScope } from "./github-pr-search.js"
import {
  jsonRecord,
  mapApiFiles,
  mapIssue,
  mapIssueListItem,
  mapLinkedPrs,
  mapIssueSummary,
  mapHomePullRequest,
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

const ISSUE_INBOX_QUERY = `query($endCursor:String){
  viewer{login}
  search(query:"is:issue is:open involves:@me sort:updated-desc",type:ISSUE,first:100,after:$endCursor){
    nodes{... on Issue{
      assignees(first:100){nodes{login avatarUrl}} author{login avatarUrl} body comments{totalCount}
      labels(first:100){nodes{name color}} number repository{nameWithOwner}
      state title updatedAt url
    }}
    pageInfo{hasNextPage endCursor}
  }
}`

const HOME_PR_FIELDS = `fragment H on PullRequest{
  id number title url isDraft state createdAt updatedAt repository{nameWithOwner} author{login}
  reviewDecision viewerLatestReview{submittedAt} commits(last:1){nodes{commit{statusCheckRollup{state}}}}
}`

// One call: authored PRs, the review pool (review-requested includes the viewer's teams),
// which pool PRs ask the viewer directly, and the frozen pick read by node id.
const HOME_QUERY = `${HOME_PR_FIELDS}
query($open:String!,$closed:String!,$ids:[ID!]!){
  viewer{login}
  open:search(query:$open,type:ISSUE,first:10){issueCount nodes{...H}}
  closed:search(query:$closed,type:ISSUE,first:10){issueCount nodes{...H}}
  pool:search(query:"is:pr is:open review-requested:@me -author:@me draft:false sort:created-asc",type:ISSUE,first:30){nodes{...H}}
  direct:search(query:"is:pr is:open user-review-requested:@me -author:@me draft:false sort:created-asc",type:ISSUE,first:30){nodes{...H}}
  picked:nodes(ids:$ids){...H}
}`

const LIST_PR_FIELDS = `fragment L on PullRequest{
  assignees(first:20){nodes{login}} author{login avatarUrl} comments{totalCount} isDraft additions deletions
  headRefName baseRefName labels(first:20){nodes{name color}} number repository{nameWithOwner}
  reviewRequests(first:20){nodes{requestedReviewer{... on User{login}}}} state title updatedAt url
}`

// ISSUE_ADVANCED accepts OR groups (team + members) and cursor paging; ~1 GraphQL point per page.
const PR_SEARCH_QUERY = `${LIST_PR_FIELDS}
query($q:String!,$after:String){
  viewer{login} rateLimit{remaining resetAt}
  search(query:$q,type:ISSUE_ADVANCED,first:${PR_PAGE_SIZE},after:$after){
    issueCount nodes{...L} pageInfo{hasNextPage endCursor}
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
const GH_RATE_LIMIT = /rate limit|retry-after|secondary rate/i
// gh hides response headers, so a limit hit cools its bucket down: 60s, doubling per repeat.
// Search is skipped: the team inbox already tracks its own per-account search cooldown.
const ghGate = makeRateGate()
const ghBucket = (args: ReadonlyArray<string>): string | null =>
  args[0] !== "api" ? "core" : args.some((arg) => arg.startsWith("search/")) ? null : args.includes("graphql") ? "graphql" : "core"
const GH_AUTH_FAILURE = /gh auth login|not logged in|authentication|bad credentials|HTTP 401/i
/** `gh auth status` is a network round trip, and every GitHub read asked it first. */
const AUTH_TTL_MS = 5 * 60_000
// The entry is set before the probe runs, so concurrent callers share one `gh auth status`.
let authProbe: {
  readonly expires: number
  readonly ok: Effect.Effect<boolean, never, CommandExecutor.CommandExecutor>
} | null = null
/** Map a failed gh run to an error; a rate-limit message also cools its bucket down. */
const ghFailure = (message: string, bucket: string | null): GitHubApiError => {
  if (GH_AUTH_FAILURE.test(message)) authProbe = null
  if (GH_RATE_LIMIT.test(message)) {
    if (bucket !== null) ghGate.trip(bucket)
    return new GitHubApiError({ reason: "rate-limited", message })
  }
  return new GitHubApiError({
    reason: NO_PULL_REQUEST.test(message) || NOT_FOUND.test(message) ? "not-found" : "unavailable",
    message
  })
}
/** Caps concurrent gh processes; the gate's own `run` is Promise-based, so Effect calls share this. */
const ghSlots = Effect.unsafeMakeSemaphore(MAX_IN_FLIGHT)
/**
 * Open PRs by head branch, one `gh pr list` per clone (keyed by git common dir)
 * shared for OPEN_PRS_TTL_MS. The app sweep asks for every worktree each tick;
 * without this each asked GitHub separately (43 worktrees → 43 calls a minute).
 */
const OPEN_PRS_TTL_MS = 20_000
const openPrCache = new Map<string, {
  readonly expires: number
  readonly prs: Effect.Effect<ReadonlyMap<string, number>, GitHubApiError, CommandExecutor.CommandExecutor>
}>()
const ghCalls = new Map<string, number>()
/** A fixed set of labels: `api` calls collapse to graphql/search/rest so endpoints never become keys. */
export const ghCallLabel = (args: ReadonlyArray<string>): string => {
  if (args[0] === "api") {
    return args.includes("graphql") ? "api graphql" : args.some((arg) => arg.startsWith("search/")) ? "api search" : "api rest"
  }
  const sub = args[1]
  return sub === undefined || sub.startsWith("-") ? String(args[0]) : `${args[0]} ${sub}`
}
/** gh processes the app spawned since launch, by `gh <command> <subcommand>` (dev perf monitor reads it). */
export const ghCallCounts = (): Readonly<Record<string, number>> => Object.fromEntries(ghCalls)
/** Test isolation only: the gate and PR cache are module state shared by every gh call. */
export const resetGhRateGate = (): void => {
  ghGate.clear("core")
  ghGate.clear("graphql")
  openPrCache.clear()
  authProbe = null
  ghCalls.clear()
}
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
  environment?: Readonly<Record<string, string>>,
  /** gh exits 1 when a GraphQL field errors but still prints `data` (e.g. a deleted node id). */
  keepPartialData = false
): Effect.Effect<string, GitHubApiError, CommandExecutor.CommandExecutor> =>
  ghSlots.withPermits(1)(Effect.scoped(
    Effect.gen(function* () {
      const bucket = ghBucket(args)
      if (bucket !== null) yield* Effect.try({ try: () => ghGate.check(bucket), catch: (error) => error as GitHubApiError })
      const label = ghCallLabel(args)
      ghCalls.set(label, (ghCalls.get(label) ?? 0) + 1)
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
      if (exitCode !== 0 && !(keepPartialData && stdout.trimStart().startsWith("{\"data\":{"))) {
        return yield* Effect.fail(ghFailure(stderr.trim() || stdout.trim() || `gh exited ${exitCode}`, bucket))
      }
      if (bucket !== null) ghGate.clear(bucket)
      return stdout.trim()
    })
  ).pipe(
    Effect.catchAll((error) =>
      error instanceof GitHubApiError
        ? Effect.fail(error)
        : Effect.fail(new GitHubApiError({ reason: "unavailable", message: "GitHub CLI failed." }))
    )
  ))

const json = (
  cwd: string | null,
  args: ReadonlyArray<string>,
  stdin?: string,
  keepPartialData = false
): Effect.Effect<unknown, GitHubApiError, CommandExecutor.CommandExecutor> =>
  execute(cwd, args, stdin, undefined, keepPartialData).pipe(
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
    "pr", "list", ...repoArgs(cwd === null ? repository : null), "--state", "open", "--author", "@me",
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
  Effect.gen(function* () {
    const raw = yield* json(cwd, ["issue", "view", String(number), ...repoArgs(repository), "--json", ISSUE_FIELDS])
    const issue = mapIssue(raw)
    const [owner, repo] = repository
      ? slugParts(repository.replace(/^github\.com\//, ""))
      : yield* slugAt(cwd ?? "").pipe(Effect.map(slugParts))
    const timeline = yield* json(cwd, [
      "api", `repos/${owner}/${repo}/issues/${number}/timeline`, "--paginate", "--slurp"
    ])
    const linkedPrs = mapLinkedPrs(Array.isArray(timeline) ? timeline.flat() : [])
    return linkedPrs.length ? { ...issue, linkedPrs } : issue
  })

const writeJson = (
  cwd: string | null,
  args: ReadonlyArray<string>,
  body: unknown
): Effect.Effect<void, GitHubApiError, CommandExecutor.CommandExecutor> =>
  execute(cwd, args, JSON.stringify(body)).pipe(Effect.asVoid)

const gitAt = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<string | null, never, CommandExecutor.CommandExecutor> =>
  Command.make("git", ...args).pipe(
    Command.workingDirectory(cwd),
    Command.string,
    Effect.map((output) => output.trim() || null),
    Effect.orElseSucceed(() => null)
  )

// ponytail: first 200 open PRs per repo; page if a repo ever has more open at once.
const listOpenPrs = (cwd: string): Effect.Effect<ReadonlyMap<string, number>, GitHubApiError, CommandExecutor.CommandExecutor> =>
  // Only the signed-in user's PRs: a teammate's PR on a same-named branch must never auto-link.
  json(cwd, ["pr", "list", "--state", "open", "--author", "@me", "--limit", "200", "--json", "number,headRefName,isCrossRepository"]).pipe(
    Effect.map((raw) => new Map(records(raw).flatMap((pr) =>
      pr.isCrossRepository !== true && typeof pr.headRefName === "string" && typeof pr.number === "number"
        ? [[pr.headRefName, pr.number] as const]
        : []
    )))
  )

const openPrsFor = (cwd: string, clone: string) =>
  Effect.gen(function* () {
    const hit = openPrCache.get(clone)
    if (hit !== undefined && hit.expires > Date.now()) return yield* hit.prs
    const prs = yield* Effect.cached(listOpenPrs(cwd))
    openPrCache.set(clone, { expires: Date.now() + OPEN_PRS_TTL_MS, prs })
    return yield* prs
  })

/** The open PR whose head is this worktree's branch, from the clone's shared open-PR list. */
const prForWorktree = (cwd: string): Effect.Effect<number | null, GitHubApiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const [branch, clone] = yield* Effect.all([
      gitAt(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      gitAt(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ])
    if (branch === null || branch === "HEAD") return null
    return (yield* openPrsFor(cwd, clone ?? cwd)).get(branch) ?? null
  })

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
  if (error.reason === "rate-limited" || /rate limit|retry-after|secondary rate/i.test(message)) {
    return new GitHubApiError({ reason: "rate-limited", message: "GitHub's rate limit was reached.", ...(error.retryAt ? { retryAt: error.retryAt } : {}) })
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

const mapListNode = (value: unknown, viewerLogin: string | null): ReadonlyArray<PullRequestListItem> => {
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
  }, repository, viewerLogin)]
}

/** Stop paging before GitHub does: under the floor, the graphql bucket waits for the reset. */
const noteRateLimit = (data: Json): void => {
  const limit = jsonRecord(data.rateLimit)
  if (typeof limit.remaining === "number" && limit.remaining < RATE_LIMIT_FLOOR && typeof limit.resetAt === "string") {
    ghGate.trip("graphql", limit.resetAt)
  }
}

const viewerOf = (data: Json): string | null => {
  const login = jsonRecord(data.viewer).login
  return typeof login === "string" ? login : null
}

const graphqlData = (query: string, variables: Record<string, unknown>, keepPartialData = false) =>
  json(null, ["api", "graphql", "--hostname", "github.com", "--input", "-"], JSON.stringify({ query, variables }), keepPartialData).pipe(
    Effect.map((raw) => {
      const data = jsonRecord(jsonRecord(raw).data)
      noteRateLimit(data)
      return data
    })
  )

const emptyPage = (warning: string): PrSearchPage =>
  ({ prs: [], total: 0, endCursor: null, hasNextPage: false, viewerLogin: null, warnings: [warning] })

const searchPrs = (query: string, after: string | null) => graphqlData(PR_SEARCH_QUERY, { q: query, after }).pipe(
  Effect.map((data): PrSearchPage => {
    const search = jsonRecord(data.search)
    const pageInfo = jsonRecord(search.pageInfo)
    const viewerLogin = viewerOf(data)
    const total = typeof search.issueCount === "number" ? search.issueCount : 0
    return {
      prs: (Array.isArray(search.nodes) ? search.nodes : []).flatMap((node) => mapListNode(node, viewerLogin)),
      total,
      endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
      hasNextPage: pageInfo.hasNextPage === true,
      viewerLogin,
      warnings: total > 1000 ? ["GitHub search serves the first 1,000 matches. Narrow the filters to see more."] : []
    }
  })
)

export type PrSearchInput = {
  readonly filters: PrSearchFilters
  readonly team: { readonly accountId: string; readonly organization: string; readonly teamSlug: string; readonly queue: GitHubTeamQueue } | null
  readonly after: string | null
  readonly refresh: boolean
}

const teamScope = (
  account: GitHubCliAccount, team: NonNullable<PrSearchInput["team"]>, firstPage: boolean, refresh: boolean, cache: DiscoveryCache
) => Effect.gen(function* () {
  validateTeam(team.organization, team.teamSlug)
  // One membership check per list load, not per page.
  if (firstPage) {
    const membership = jsonRecord(yield* teamApi(`orgs/${team.organization}/teams/${team.teamSlug}/memberships/${account.login}`))
    if (membership.state !== "active") return yield* Effect.fail(teamValidation("You are no longer an active member of this team. Refresh teams."))
  }
  const repositories = team.queue === "repositories"
  const rows = yield* cachedTeamPages(account.id, `orgs/${team.organization}/teams/${team.teamSlug}/${repositories ? "repos" : "members"}`, refresh, cache)
  const values = rows.flatMap((row) => {
    const value = repositories ? row.full_name : row.login
    return typeof value === "string" ? [value] : []
  })
  return {
    organization: team.organization, slug: team.teamSlug, queue: team.queue,
    members: repositories ? [] : values, repositories: repositories ? values : []
  } satisfies TeamScope
})

const searchQuery = (filters: PrSearchFilters, scope: TeamScope | null) =>
  Effect.try({ try: () => buildPrSearchQuery(filters, scope), catch: (error) => error instanceof GitHubApiError ? error : teamValidation("Invalid filters.") })

export class GitHubCli extends Effect.Service<GitHubCli>()("@jingler/GitHubCli", {
  accessors: true,
  effect: Effect.sync(() => {
    const discoveryCache: DiscoveryCache = new Map()
    return {
    teams: () => withTeamAccount(null, (account) => discoverTeams().pipe(Effect.map((teams) => {
      const memberships = new Set(teams.map((team) => `orgs/${team.organization}/teams/${team.slug}/`.toLowerCase()))
      for (const key of discoveryCache.keys()) {
        const path = key.slice(key.indexOf("/") + 1).toLowerCase()
        if (key.startsWith(`${account.id}/`) && path.includes("/teams/") && ![...memberships].some((prefix) => path.startsWith(prefix))) discoveryCache.delete(key)
      }
      return { account, teams }
    }))),
    /** One 25-row cursor page; every filter is in the search, so later pages never hide matches. */
    prSearch: (input: PrSearchInput) => {
      if (input.team === null) {
        return searchQuery(input.filters, null).pipe(Effect.flatMap((query) => searchPrs(query ?? "", input.after)))
      }
      const team = input.team
      return withTeamAccount(team.accountId, (account) => Effect.gen(function* () {
        const scope = yield* teamScope(account, team, input.after === null, input.refresh, discoveryCache)
        const query = yield* searchQuery(input.filters, scope)
        if (query === null) {
          return emptyPage(team.queue === "repositories" ? "This team has no repositories of its own." : "This team has no members.")
        }
        const page = yield* searchPrs(query, input.after)
        const warning = scopeWarning(scope)
        return warning === null ? page : { ...page, warnings: [...page.warnings, warning] }
      }))
    },
    /** Specific PRs by repository + number (the session's linked PRs), one aliased call. */
    prsByKey: (keys: ReadonlyArray<{ readonly repository: string; readonly number: number }>) => Effect.gen(function* () {
      if (keys.length === 0) return [] as ReadonlyArray<PullRequestListItem>
      const variables: Record<string, unknown> = {}
      const declarations: string[] = []
      const fields: string[] = []
      for (const [index, key] of keys.entries()) {
        yield* Effect.try({ try: () => validateTeamPr(key.repository, key.number), catch: (error) => error as GitHubApiError })
        const [owner, name] = slugParts(key.repository)
        Object.assign(variables, { [`o${index}`]: owner, [`n${index}`]: name, [`k${index}`]: key.number })
        declarations.push(`$o${index}:String!,$n${index}:String!,$k${index}:Int!`)
        fields.push(`p${index}:repository(owner:$o${index},name:$n${index}){pullRequest(number:$k${index}){...L}}`)
      }
      // A deleted PR or lost repo access nulls its alias; keep the rest.
      const data = yield* graphqlData(`${LIST_PR_FIELDS}\nquery(${declarations.join(",")}){viewer{login} rateLimit{remaining resetAt} ${fields.join(" ")}}`, variables, true)
      const viewer = viewerOf(data)
      return keys.flatMap((_, index) => mapListNode(jsonRecord(data[`p${index}`]).pullRequest, viewer))
    }),
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
      Effect.gen(function* () {
        const hit = authProbe
        if (hit !== null && hit.expires > Date.now()) return yield* hit.ok
        const ok = yield* Effect.cached(execute(null, ["auth", "status", "--active", "--hostname", "github.com"]).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        ))
        const entry = { expires: Date.now() + AUTH_TTL_MS, ok }
        authProbe = entry
        const result = yield* ok
        // Only a success is kept: a signed-out or transient failure must not outlive the next `gh auth login`.
        if (!result && authProbe === entry) authProbe = null
        return result
      }),
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
    prForWorktree,
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
    issueViewBySlug: (repository: string, number: number) => issueView(null, repository, number),
    prState: (cwd: string, number: number): Effect.Effect<SessionPrStatus | null, GitHubApiError, CommandExecutor.CommandExecutor> =>
      json(cwd, [
        "pr", "view", String(number), "--json", "state,isDraft,mergedAt,updatedAt,statusCheckRollup"
      ]).pipe(Effect.map((raw) => mapPrState(raw, mapPrView(raw).checks))),
    prHeadSha: (cwd: string, number: number) =>
      execute(cwd, ["pr", "view", String(number), "--json", "headRefOid", "--jq", ".headRefOid"]),
    prHeadShaBySlug: (repository: string, number: number) =>
      execute(null, ["pr", "view", String(number), "--repo", repository, "--json", "headRefOid", "--jq", ".headRefOid"]),
    prDiffBySlug: (repository: string, number: number) => execute(null, ["pr", "diff", String(number), "--repo", repository]),
    prReviewCommentsBySlug: (repository: string, number: number, input: Parameters<typeof reviewPayload>[0]) =>
      writeJson(null, ["api", "-X", "POST", `repos/${repository}/pulls/${number}/reviews`, "--input", "-"], reviewPayload(input)),
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
    prSetBase: (cwd: string, number: number, base: string) =>
      execute(cwd, ["pr", "edit", String(number), "--base", base]).pipe(Effect.asVoid),
    prReady: (cwd: string, number: number) =>
      execute(cwd, ["pr", "ready", String(number)]).pipe(Effect.asVoid),
    issueComment: (cwd: string, number: number, body: string) =>
      execute(cwd, ["issue", "comment", String(number), "--body-file", "-"], body).pipe(Effect.asVoid),
    closeIssue: (cwd: string, number: number) =>
      execute(cwd, ["issue", "close", String(number)]).pipe(Effect.asVoid),
    issueCommentBySlug: (repository: string, number: number, body: string) =>
      execute(null, ["issue", "comment", String(number), "--repo", repository, "--body-file", "-"], body).pipe(Effect.asVoid),
    issueCloseBySlug: (repository: string, number: number) =>
      execute(null, ["issue", "close", String(number), "--repo", repository]).pipe(Effect.asVoid),
    issueReopenBySlug: (repository: string, number: number) =>
      execute(null, ["issue", "reopen", String(number), "--repo", repository]).pipe(Effect.asVoid),
    issueInbox: () =>
      Effect.gen(function* () {
        const raw = yield* json(null, [
          "api", "graphql", "--paginate", "--slurp", "-f", `query=${ISSUE_INBOX_QUERY}`
        ])
        const pages = Array.isArray(raw) ? raw.map(jsonRecord) : []
        const viewer = jsonRecord(jsonRecord(pages[0]?.data).viewer).login
        const issues = pages.flatMap((page): ReadonlyArray<IssueListItem> => {
          const nodes = jsonRecord(jsonRecord(page.data).search).nodes
          if (!Array.isArray(nodes)) return []
          return nodes.flatMap((value): ReadonlyArray<IssueListItem> => {
            const row = jsonRecord(value)
            const repository = jsonRecord(row.repository).nameWithOwner
            if (typeof repository !== "string") return []
            const comments = jsonRecord(row.comments).totalCount
            return [mapIssueListItem({
              ...row,
              assignees: jsonRecord(row.assignees).nodes,
              labels: jsonRecord(row.labels).nodes,
            }, repository, typeof comments === "number" ? comments : 0)]
          })
        })
        return { issues, viewerLogin: typeof viewer === "string" ? viewer : null, warnings: [] as ReadonlyArray<string> }
      }),
    home: (input: { readonly picked: ReadonlyArray<string>; readonly closedSince: string }) =>
      Effect.gen(function* () {
        const body = JSON.stringify({
          query: HOME_QUERY,
          variables: {
            open: "is:pr is:open author:@me sort:updated-desc",
            closed: `is:pr is:closed author:@me closed:>=${input.closedSince} sort:updated-desc`,
            ids: input.picked
          }
        })
        const raw = jsonRecord(yield* json(null, ["api", "graphql", "--input", "-"], body, true))
        // Only a deleted/inaccessible picked node is a real answer (done); any other error is a failed
        // read, and treating it as empty would freeze an empty pick or mark reviews done.
        const failed = (Array.isArray(raw.errors) ? raw.errors : []).some((error) => {
          const entry = jsonRecord(error)
          return !(entry.type === "NOT_FOUND" && Array.isArray(entry.path) && entry.path[0] === "picked")
        })
        if (failed) return yield* Effect.fail(new GitHubApiError({ reason: "unavailable", message: "GitHub returned a partial result. Try again shortly." }))
        const data = jsonRecord(raw.data)
        const search = (key: string) => jsonRecord(data[key])
        const nodes = (key: string) => {
          const value = search(key).nodes
          return Array.isArray(value) ? value : []
        }
        const directIds = new Set(nodes("direct").flatMap((node) => {
          const id = jsonRecord(node).id
          return typeof id === "string" ? [id] : []
        }))
        const map = (key: string) => nodes(key).flatMap((node) => mapHomePullRequest(node, directIds) ?? [])
        // Direct requests come from their own search so a newer personal request still beats 30 older team ones.
        const pool = [...new Map([...map("direct"), ...map("pool")].map((pr) => [pr.id, pr])).values()]
        const count = (key: string) => typeof search(key).issueCount === "number" ? search(key).issueCount as number : 0
        const picked = Array.isArray(data.picked) ? data.picked : []
        return {
          viewerLogin: typeof jsonRecord(data.viewer).login === "string" ? jsonRecord(data.viewer).login as string : "",
          mine: [...map("open"), ...map("closed")].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          mineTotal: count("open") + count("closed"),
          reviewPool: pool,
          picked: input.picked.map((_, index) => mapHomePullRequest(picked[index], directIds))
        } satisfies HomeGitHub
      }),
    }
  })
}) {}
