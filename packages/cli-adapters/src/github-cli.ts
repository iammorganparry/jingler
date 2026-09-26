import type {
  Issue,
  PrFileChange,
  PrMergeMethod,
  PullRequest,
  PullRequestListItem,
  ReviewSubmitKind,
  SessionPrStatus
} from "@jingler/core"
import { GitHubApiError } from "@jingler/core"
import { Command } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
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
      const command = environment === undefined
        ? fed
        : fed.pipe(Command.env({ ...process.env, ...environment }))
      const child = yield* command.pipe(Command.start)
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [decode(child.stdout), decode(child.stderr), child.exitCode],
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

const prView = (
  cwd: string | null,
  repository: string | null,
  number: number
): Effect.Effect<PullRequest, GitHubApiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const repositoryArgs = repoArgs(repository)
    const raw = yield* json(cwd, ["pr", "view", String(number), ...repositoryArgs, "--json", PR_FIELDS])
    const [owner, repo] = repository
      ? slugParts(repository)
      : yield* execute(cwd, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).pipe(
          Effect.map(slugParts)
        )
    const threads = yield* reviewThreads(cwd, owner, repo, number)
    const commits = yield* commitEvidence(cwd, owner, repo, number)
    return { ...mapPrView({ ...jsonRecord(raw), commits }), reviewThreads: threads }
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

const nullable = <A>(effect: Effect.Effect<A, GitHubApiError, CommandExecutor.CommandExecutor>) =>
  effect.pipe(
    Effect.map((value): A | null => value),
    Effect.catchTag("GitHubApiError", (error) =>
      NO_PULL_REQUEST.test(error.message) || NOT_FOUND.test(error.message)
        ? Effect.succeed(null)
        : Effect.fail(error)
    )
  )

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
    repository: (cwd: string) =>
      Effect.gen(function* () {
        const repository = yield* slugAt(cwd)
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
      }),
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
    issueView: (cwd: string, number: number) => nullable(issueView(cwd, null, number)),
    prState: (cwd: string, number: number): Effect.Effect<SessionPrStatus | null, GitHubApiError, CommandExecutor.CommandExecutor> =>
      nullable(json(cwd, [
        "pr", "view", String(number), "--json", "state,isDraft,mergedAt,statusCheckRollup"
      ]).pipe(Effect.map((raw) => mapPrState(raw, mapPrView(raw).checks)))),
    prHeadSha: (cwd: string, number: number) =>
      nullable(execute(cwd, ["pr", "view", String(number), "--json", "headRefOid", "--jq", ".headRefOid"])),
    prView: (cwd: string, number: number) => nullable(prView(cwd, null, number)),
    prViewBySlug: (repository: string, number: number) => nullable(prView(null, repository, number)),
    prFiles: (cwd: string, number: number): Effect.Effect<ReadonlyArray<PrFileChange>, GitHubApiError, CommandExecutor.CommandExecutor> =>
      Effect.gen(function* () {
        const repository = yield* slugAt(cwd)
        const raw = yield* json(cwd, [
          "api", `repos/${repository}/pulls/${number}/files`, "--paginate", "--slurp"
        ])
        return mapApiFiles(Array.isArray(raw) ? raw.flat() : [])
      }),
    prDiff: (cwd: string, number: number) => execute(cwd, ["pr", "diff", String(number)]),
    prCheckout: (cwd: string, number: number) =>
      Effect.gen(function* () {
        const raw = jsonRecord(yield* json(cwd, [
          "pr", "view", String(number), "--json", "headRefName,headRefOid,headRepository"
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
      }),
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
  })
}) {}
