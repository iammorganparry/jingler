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

const INBOX_FIELDS = [
  "assignees", "author", "commentsCount", "isDraft", "labels", "number", "repository",
  "state", "title", "updatedAt", "url"
].join(",")

const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{
    id isResolved isOutdated path line startLine originalLine originalStartLine resolvedBy{login}
    comments(first:50){nodes{id databaseId body createdAt diffHunk authorAssociation author{login avatarUrl __typename} pullRequestReview{id} reactionGroups{content reactors{totalCount}}}}
  }}}}
}`

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
    const threads = yield* json(cwd, [
      "api", "graphql", "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${number}`,
      "-f", `query=${REVIEW_THREADS_QUERY}`
    ]).pipe(Effect.map(mapReviewThreads), Effect.orElseSucceed(() => []))
    return { ...mapPrView(raw), reviewThreads: threads }
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
        Effect.orElseSucceed(() => null)
      ),
    prView: (cwd: string, number: number) => prView(cwd, null, number),
    prViewBySlug: (repository: string, number: number) => prView(null, repository, number),
    inbox: () =>
      Effect.gen(function* () {
        const raw = yield* json(null, [
          "search", "prs", "--state", "open", "--involves", "@me", "--sort", "updated",
          "--order", "desc", "--limit", "100", "--json", INBOX_FIELDS
        ])
        if (!Array.isArray(raw)) return []
        return raw.flatMap((value): ReadonlyArray<PullRequestListItem> => {
          const row = jsonRecord(value)
          const repository = jsonRecord(row.repository).nameWithOwner
          if (typeof repository !== "string") return []
          return [mapPullRequestListItem({ ...row, comments: row.commentsCount }, repository, null)]
        })
      })
  })
}) {}
