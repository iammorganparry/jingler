import type { PullRequest, PullRequestListItem } from "@jingler/core"
import { GitHubApiError } from "@jingler/core"
import { Command } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, Stream } from "effect"
import { jsonRecord, mapPrView, mapPullRequestListItem, mapReviewThreads } from "./github-mappers.js"
import { which } from "./command.js"

const PR_FIELDS = [
  "state", "number", "title", "body", "headRefName", "baseRefName", "headRefOid",
  "isDraft", "commits", "files", "additions", "deletions", "author", "createdAt",
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

const decode = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.runFold("", (output, chunk) => output + chunk))

const execute = (
  cwd: string | null,
  args: ReadonlyArray<string>
): Effect.Effect<string, GitHubApiError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = Command.make("gh", ...args)
      const command = cwd === null ? base : base.pipe(Command.workingDirectory(cwd))
      const process = yield* command.pipe(Command.start)
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [decode(process.stdout), decode(process.stderr), process.exitCode],
        { concurrency: 3 }
      )
      if (exitCode !== 0) {
        return yield* Effect.fail(new GitHubApiError({
          reason: "unavailable",
          message: stderr.trim() || stdout.trim() || `gh exited ${exitCode}`
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
  args: ReadonlyArray<string>
): Effect.Effect<unknown, GitHubApiError, CommandExecutor.CommandExecutor> =>
  execute(cwd, args).pipe(
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

const prView = (
  cwd: string | null,
  repository: string | null,
  number: number
): Effect.Effect<PullRequest, GitHubApiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const repoArgs = repository ? ["--repo", repository] : []
    const raw = yield* json(cwd, ["pr", "view", String(number), ...repoArgs, "--json", PR_FIELDS])
    const [owner, repo] = repository
      ? slugParts(repository)
      : yield* execute(cwd, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).pipe(
          Effect.map(slugParts)
        )
    const threads = yield* reviewThreads(cwd, owner, repo, number)
    const commits = yield* commitEvidence(cwd, owner, repo, number)
    return { ...mapPrView({ ...jsonRecord(raw), commits }), reviewThreads: threads }
  })

export class GitHubCli extends Effect.Service<GitHubCli>()("@jingler/GitHubCli", {
  accessors: true,
  effect: Effect.succeed({
    available: () =>
      which("gh").pipe(
        Effect.flatMap((bin) =>
          bin === null
            ? Effect.succeed(false)
            : execute(null, ["auth", "status", "--active", "--hostname", "github.com"]).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false)
              )
        )
      ),
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
    prView: (cwd: string, number: number) => prView(cwd, null, number),
    prViewBySlug: (repository: string, number: number) => prView(null, repository, number),
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
  })
}) {}
