import type {
  GitHubRateLimit,
  Issue,
  IssueSummary,
  PrCheck,
  PrCheckStatus,
  PrCommit,
  PrFileChange,
  PrLabel,
  PrReviewKind,
  PrReviewer,
  PrReviewThread,
  PrState,
  PrThreadComment,
  PrSummary,
  PullRequestListItem,
  PrTimelineItem,
  PullRequest,
  SessionPrStatus
} from "@jingler/core"
import { PrAuthorAssociation } from "@jingler/core"
import type { EmitterWebhookEventName } from "@octokit/webhooks"
import { validateEventName } from "@octokit/webhooks"
import { Option, Schema } from "effect"

type Json = Record<string, unknown>

export const jsonRecord = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {}

const rows = (value: unknown): ReadonlyArray<Json> =>
  Array.isArray(value) ? value.map(jsonRecord) : []

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const field = (value: Json, camel: string, snake?: string): unknown =>
  value[camel] ?? (snake === undefined ? undefined : value[snake])

const nestedLogin = (value: unknown): string | null => text(jsonRecord(value).login)

const timelineKindOf = (
  state: string | null
): "commented" | "approved" | "changes_requested" => {
  switch (state?.toUpperCase()) {
    case "APPROVED":
      return "approved"
    case "CHANGES_REQUESTED":
      return "changes_requested"
    default:
      return "commented"
  }
}

const reviewKindOf = (state: string | null): PrReviewKind => timelineKindOf(state)

export const checkStatusOf = (candidate: unknown): PrCheckStatus => {
  const check = jsonRecord(candidate)
  const status = text(check.status)?.toUpperCase()
  const conclusion = text(check.conclusion)?.toUpperCase()
  const state = text(check.state)?.toUpperCase()
  if (status === "IN_PROGRESS") return "running"
  if (status === "QUEUED" || status === "PENDING") return "pending"
  const verdict = conclusion ?? state
  if (verdict === "SUCCESS" || verdict === "NEUTRAL" || verdict === "SKIPPED") return "pass"
  if (
    verdict === "FAILURE" ||
    verdict === "ERROR" ||
    verdict === "TIMED_OUT" ||
    verdict === "CANCELLED" ||
    verdict === "STARTUP_FAILURE" ||
    verdict === "ACTION_REQUIRED"
  ) {
    return "fail"
  }
  return state === "PENDING" ? "running" : "pending"
}

export const dedupeChecks = (checks: ReadonlyArray<PrCheck>): ReadonlyArray<PrCheck> => {
  const seen = new Set<string>()
  return checks.filter((check) => {
    const key = check.name.trim().toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const rollupChecks = (
  checks: ReadonlyArray<{ readonly status: PrCheckStatus }>
): PrCheckStatus | null => {
  if (checks.length === 0) return null
  if (checks.some((check) => check.status === "fail")) return "fail"
  if (checks.some((check) => check.status === "running")) return "running"
  if (checks.some((check) => check.status === "pending")) return "pending"
  return "pass"
}

const durationOf = (candidate: Json): number | null => {
  const started = text(field(candidate, "startedAt", "started_at"))
  const completed = text(field(candidate, "completedAt", "completed_at"))
  if (!(started && completed)) return null
  const duration = new Date(completed).getTime() - new Date(started).getTime()
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

export const mapCheck = (candidate: unknown): PrCheck => {
  const check = jsonRecord(candidate)
  const normalizedStatus = text(check.status)
  const status =
    normalizedStatus === "pending" ||
    normalizedStatus === "running" ||
    normalizedStatus === "pass" ||
    normalizedStatus === "fail"
      ? normalizedStatus
      : checkStatusOf(check)
  return {
    name: text(check.name) ?? text(check.context) ?? "check",
    status,
    detailsUrl:
      text(field(check, "detailsUrl", "details_url")) ??
      text(field(check, "targetUrl", "target_url")),
    durationMs: integer(check.durationMs) ?? durationOf(check)
  }
}

export const mapPrCommit = (raw: unknown): PrCommit => {
  const row = jsonRecord(raw)
  const commit = jsonRecord(row.commit)
  const author = jsonRecord(row.author)
  const commitAuthor = jsonRecord(commit.author)
  const cliAuthors = jsonRecord(row.authors)
  const cliAuthor = rows(cliAuthors.nodes ?? row.authors)[0]
  return {
    sha: text(row.sha) ?? text(row.oid) ?? "",
    message: text(row.messageHeadline) ?? (text(commit.message) ?? "").split("\n", 1)[0] ?? "",
    author:
      text(cliAuthor?.login) ??
      nestedLogin(cliAuthor?.user) ??
      text(cliAuthor?.name) ??
      text(author.login) ??
      text(commitAuthor.name) ??
      "unknown",
    committedAt: text(row.committedDate) ?? text(commitAuthor.date) ?? "",
    url: text(field(row, "htmlUrl", "html_url")) ?? text(row.url) ?? "",
    verified:
      jsonRecord(commit.verification).verified === true || jsonRecord(row.signature).isValid === true
  }
}

const labelsOf = (value: unknown): ReadonlyArray<PrLabel> =>
  rows(value).map((label) => ({
    name: text(label.name) ?? "",
    color: text(label.color)
  }))

const avatarOf = (value: Json): string | null =>
  text(field(value, "avatarUrl", "avatar_url"))

const mergeStateOf = (pr: Json): string | null => {
  const explicit =
    text(field(pr, "mergeStateStatus", "merge_state_status")) ?? text(pr.mergeable_state)
  if (explicit) return explicit.toUpperCase()
  if (pr.mergeable === false) return "DIRTY"
  if (pr.mergeable === true) return "CLEAN"
  return null
}

const mergeableOf = (pr: Json): string | null => {
  const explicit = text(pr.mergeable)
  if (explicit) return explicit.toUpperCase()
  if (pr.mergeable === true) return "MERGEABLE"
  if (pr.mergeable === false) return "CONFLICTING"
  return null
}

const collectReviewers = (reviews: ReadonlyArray<Json>, requested: ReadonlyArray<Json>) => {
  const reviewerStates = new Map<string, PrReviewKind>()
  for (const review of reviews) {
    const login = nestedLogin(review.author ?? review.user)
    const reviewState = text(review.state)?.toUpperCase()
    if (!login || reviewState === "PENDING" || reviewState === "DISMISSED") continue
    const kind = reviewKindOf(reviewState ?? null)
    if (kind !== "commented" || !reviewerStates.has(login)) reviewerStates.set(login, kind)
  }
  for (const requestedReviewer of requested) {
    const login = text(requestedReviewer.login) ?? text(requestedReviewer.name)
    if (login && !reviewerStates.has(login)) reviewerStates.set(login, "pending")
  }
  const reviewers: ReadonlyArray<PrReviewer> = [...reviewerStates].map(([login, reviewerState]) => ({
    login,
    state: reviewerState
  }))
  return reviewers
}

const collectMergeBlockers = (
  mergeable: string | null,
  mergeStateStatus: string | null,
  checks: ReadonlyArray<PrCheck>,
  reviewers: ReadonlyArray<PrReviewer>
): ReadonlyArray<string> => {
  const mergeBlockers: Array<string> = []
  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
    mergeBlockers.push("Merge conflicts")
  }
  if (mergeStateStatus === "BLOCKED") mergeBlockers.push("Blocked by branch protection")
  if (mergeStateStatus === "BEHIND") {
    mergeBlockers.push("Branch is out of date with the base")
  }
  const failing = checks.filter((check) => check.status === "fail").length
  if (failing > 0) mergeBlockers.push(`${failing} failing check${failing === 1 ? "" : "s"}`)
  const changeRequests = reviewers.filter((reviewer) => reviewer.state === "changes_requested").length
  if (changeRequests > 0) {
    mergeBlockers.push(`${changeRequests} change request${changeRequests === 1 ? "" : "s"}`)
  }
  return mergeBlockers
}

const pullRequestDetails = (pr: Json) => {
  const author = jsonRecord(pr.author ?? pr.user)
  const head = jsonRecord(pr.head)
  const base = jsonRecord(pr.base)
  return {
    number: integer(pr.number) ?? 0,
    title: text(pr.title) ?? "",
    body: text(pr.body),
    url: text(field(pr, "htmlUrl", "html_url")) ?? text(pr.url) ?? "",
    headRefName: text(field(pr, "headRefName", "head_ref")) ?? text(head.ref) ?? "",
    baseRefName: text(field(pr, "baseRefName", "base_ref")) ?? text(base.ref) ?? "",
    author: { login: text(author.login) ?? "unknown", avatarUrl: avatarOf(author) },
    createdAt: text(field(pr, "createdAt", "created_at")) ?? "",
    commits: integer(pr.commits) ?? rows(pr.commit_items ?? pr.commits).length,
    commitItems: rows(pr.commit_items ?? pr.commits).map(mapPrCommit),
    changedFiles: integer(field(pr, "changedFiles", "changed_files")) ?? rows(pr.files).length,
    additions: integer(pr.additions) ?? 0,
    deletions: integer(pr.deletions) ?? 0,
    labels: labelsOf(pr.labels)
  }
}

/** Map a REST pull plus its separately paginated related resources. */
export const mapPrView = (raw: unknown): PullRequest => {
  const pr = jsonRecord(raw)
  const stateRaw = text(pr.state)?.toUpperCase()
  const isDraft = field(pr, "isDraft", "draft") === true
  const merged = field(pr, "mergedAt", "merged_at") !== null && field(pr, "mergedAt", "merged_at") !== undefined
  const state: PrState = merged
    ? "merged"
    : stateRaw === "CLOSED"
      ? "closed"
      : isDraft
        ? "draft"
        : "open"
  const reviews = rows(pr.reviews)
  const requested = rows(field(pr, "reviewRequests", "requested_reviewers"))
  const issueComments = rows(pr.comments)
  const checks = rows(field(pr, "statusCheckRollup", "checks")).map(mapCheck)

  const reviewers = collectReviewers(reviews, requested)

  const reviewItems: ReadonlyArray<PrTimelineItem> = reviews
    .filter((review) => {
      const reviewState = text(review.state)?.toUpperCase()
      return (
        reviewState === "APPROVED" ||
        reviewState === "CHANGES_REQUESTED" ||
        (text(review.body) ?? "").length > 0
      )
    })
    .map((review, index) => ({
      id: text(review.node_id) ?? text(review.id) ?? `review-${index}`,
      author: nestedLogin(review.author ?? review.user) ?? "unknown",
      kind: timelineKindOf(text(review.state)),
      body: text(review.body) ?? "",
      createdAt:
        text(field(review, "submittedAt", "submitted_at")) ??
        text(field(review, "createdAt", "created_at")) ??
        "",
      path: null,
      line: null
    }))
  const commentItems: ReadonlyArray<PrTimelineItem> = issueComments.map((comment, index) => ({
    id: text(comment.node_id) ?? String(integer(comment.id) ?? `comment-${index}`),
    author: nestedLogin(comment.author ?? comment.user) ?? "unknown",
    kind: "commented",
    body: text(comment.body) ?? "",
    createdAt: text(field(comment, "createdAt", "created_at")) ?? "",
    path: null,
    line: null
  }))
  const timeline = [...reviewItems, ...commentItems].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  )

  const mergeable = mergeableOf(pr)
  const mergeStateStatus = mergeStateOf(pr)
  const mergeBlockers = collectMergeBlockers(mergeable, mergeStateStatus, checks, reviewers)

  return {
    ...pullRequestDetails(pr),
    state,
    isDraft,
    reviewers,
    timeline,
    reviewThreads: rows(pr.reviewThreads).length > 0 ? mapReviewThreads(pr.reviewThreads) : [],
    checks,
    mergeable,
    mergeStateStatus,
    mergeBlockers: [...new Set(mergeBlockers)]
  }
}

const decodeAssociation = Schema.decodeUnknownOption(PrAuthorAssociation)
const associationOf = (value: unknown): PrThreadComment["association"] =>
  Option.getOrNull(decodeAssociation(text(value)?.toUpperCase()))

const mapThreadComment = (candidate: Json): PrThreadComment => {
  const author = jsonRecord(candidate.author ?? candidate.user)
  return {
    id: text(candidate.id) ?? text(candidate.node_id) ?? "",
    databaseId: integer(field(candidate, "databaseId", "database_id")),
    author: text(author.login) ?? "unknown",
    authorAvatarUrl: avatarOf(author),
    isBot: text(author.__typename) === "Bot" || text(author.type) === "Bot",
    association: associationOf(field(candidate, "authorAssociation", "author_association")),
    body: text(candidate.body) ?? "",
    createdAt: text(field(candidate, "createdAt", "created_at")) ?? "",
    reactions: rows(field(candidate, "reactionGroups", "reaction_groups")).flatMap((reaction) => {
      const reactors = jsonRecord(reaction.reactors)
      const count = integer(reactors.totalCount) ?? integer(reaction.count) ?? 0
      const content = text(reaction.content)
      return count > 0 && content ? [{ content, count }] : []
    })
  }
}

/** Map GraphQL review-thread fixture pages without assuming one fixed envelope. */
export const mapReviewThreads = (raw: unknown): ReadonlyArray<PrReviewThread> => {
  const root = jsonRecord(raw)
  const data = jsonRecord(root.data)
  const repository = jsonRecord(data.repository ?? root.repository)
  const pullRequest = jsonRecord(repository.pullRequest ?? root.pullRequest)
  const connection = jsonRecord(pullRequest.reviewThreads ?? root.reviewThreads ?? raw)
  const nodes = rows(connection.nodes).length > 0 ? rows(connection.nodes) : rows(raw)
  return nodes.map((thread) => {
    const commentsConnection = jsonRecord(thread.comments)
    const comments = rows(commentsConnection.nodes).map(mapThreadComment)
    const firstComment = rows(commentsConnection.nodes)[0]
    const review = jsonRecord(firstComment?.pullRequestReview)
    return {
      id: text(thread.id) ?? "",
      reviewId: text(review.id),
      path: text(thread.path) ?? "",
      line: integer(thread.line),
      startLine: integer(thread.startLine),
      originalLine: integer(thread.originalLine),
      originalStartLine: integer(thread.originalStartLine),
      diffHunk: text(firstComment?.diffHunk) ?? "",
      isResolved: thread.isResolved === true,
      isOutdated: thread.isOutdated === true,
      resolvedBy: nestedLogin(thread.resolvedBy),
      comments
    }
  })
}

export const mapApiFiles = (raw: unknown): ReadonlyArray<PrFileChange> =>
  rows(raw)
    .map((file) => ({
      path: text(file.filename) ?? text(file.path) ?? "",
      additions: integer(file.additions) ?? 0,
      deletions: integer(file.deletions) ?? 0,
      commentCount: integer(field(file, "commentCount", "comments")) ?? 0,
      viewed: field(file, "viewed", "viewer_viewed") === true
    }))
    .filter((file) => file.path.length > 0)

/** Reconstruct a reviewable diff when GitHub's aggregate diff returns 406. */
export const unifiedDiffFromApiFiles = (raw: unknown): string =>
  rows(raw)
    .flatMap((file) => {
      const path = text(file.filename) ?? text(file.path)
      if (!path) return []
      const oldPath = text(file.previous_filename) ?? path
      const status = text(file.status)
      const header = [
        `diff --git a/${oldPath} b/${path}`,
        status === "added" ? "--- /dev/null" : `--- a/${oldPath}`,
        status === "removed" ? "+++ /dev/null" : `+++ b/${path}`
      ]
      // GitHub omits patches for binary and individually oversized files. Keep
      // their headers so the review surface still lists them instead of making
      // them disappear from an already-fallback diff.
      const patch = text(file.patch)
      return [...header, ...(patch === null ? [] : [patch])].join("\n")
    })
    .join("\n")

export const mapPrSummary = (raw: unknown): PrSummary => {
  const pr = jsonRecord(raw)
  const author = jsonRecord(pr.author ?? pr.user)
  const head = jsonRecord(pr.head)
  const base = jsonRecord(pr.base)
  const isDraft = field(pr, "isDraft", "draft") === true
  const rawState = text(pr.state)?.toUpperCase()
  return {
    number: integer(pr.number) ?? 0,
    title: text(pr.title) ?? "",
    headRefName: text(field(pr, "headRefName", "head_ref")) ?? text(head.ref) ?? "",
    baseRefName: text(field(pr, "baseRefName", "base_ref")) ?? text(base.ref) ?? "",
    author: { login: text(author.login) ?? "unknown", avatarUrl: avatarOf(author) },
    state: rawState === "CLOSED" ? "closed" : isDraft ? "draft" : "open",
    isDraft,
    additions: integer(pr.additions) ?? 0,
    deletions: integer(pr.deletions) ?? 0,
    updatedAt: text(field(pr, "updatedAt", "updated_at")) ?? ""
  }
}

export const mapPullRequestListItem = (
  raw: unknown,
  repository: string,
  viewerLogin: string | null
): PullRequestListItem => {
  const pr = jsonRecord(raw)
  const viewer = viewerLogin?.toLowerCase()
  const matchesViewer = (candidate: Json) =>
    viewer !== undefined && text(candidate.login)?.toLowerCase() === viewer
  return {
    ...mapPrSummary(pr),
    repository,
    labels: labelsOf(pr.labels),
    comments: (integer(pr.comments) ?? 0) + (integer(field(pr, "reviewComments", "review_comments")) ?? 0),
    assignedToViewer: rows(pr.assignees).some(matchesViewer),
    reviewRequestedFromViewer: rows(field(pr, "reviewRequests", "requested_reviewers")).some(matchesViewer)
  }
}

export const mapIssueSummary = (raw: unknown): IssueSummary => {
  const issue = jsonRecord(raw)
  const author = jsonRecord(issue.author ?? issue.user)
  const number = integer(issue.number) ?? 0
  const actor = {
    id: text(author.id) ?? text(author.login) ?? "unknown",
    name: text(author.login) ?? "unknown",
    avatarUrl: avatarOf(author)
  }
  return {
    providerId: "github",
    id: String(number),
    identifier: `#${number}`,
    title: text(issue.title) ?? "",
    url: text(field(issue, "url", "html_url")) ?? "",
    body: text(issue.body) ?? "",
    labels: labelsOf(issue.labels),
    state: text(issue.state)?.toUpperCase() === "CLOSED" ? "closed" : "open",
    author: actor,
    assignees: rows(issue.assignees).map((assignee) => ({
      id: text(assignee.id) ?? text(assignee.login) ?? "unknown",
      name: text(assignee.login) ?? "unknown",
      avatarUrl: avatarOf(assignee)
    })),
    updatedAt: text(field(issue, "updatedAt", "updated_at")) ?? ""
  }
}

export const mapIssue = (raw: unknown): Issue => {
  const issue = jsonRecord(raw)
  const author = jsonRecord(issue.author ?? issue.user)
  const number = integer(issue.number) ?? 0
  return {
    providerId: "github",
    id: String(number),
    identifier: `#${number}`,
    title: text(issue.title) ?? "",
    url: text(field(issue, "url", "html_url")) ?? "",
    state: text(issue.state)?.toUpperCase() === "CLOSED" ? "closed" : "open",
    body: text(issue.body) ?? "",
    author: {
      id: text(author.id) ?? text(author.login) ?? "unknown",
      name: text(author.login) ?? "unknown",
      avatarUrl: avatarOf(author)
    },
    assignees: rows(issue.assignees).map((assignee) => ({
      id: text(assignee.id) ?? text(assignee.login) ?? "unknown",
      name: text(assignee.login) ?? "unknown",
      avatarUrl: avatarOf(assignee)
    })),
    labels: labelsOf(issue.labels),
    updatedAt: text(field(issue, "updatedAt", "updated_at")) ?? "",
    createdAt: text(field(issue, "createdAt", "created_at")) ?? "",
    comments: rows(issue.comments).map((comment) => {
      const commentAuthor = jsonRecord(comment.author ?? comment.user)
      return {
        id:
          text(comment.id) ??
          String(integer(comment.id) ?? text(field(comment, "createdAt", "created_at")) ?? "unknown"),
        author: {
          id: text(commentAuthor.id) ?? text(commentAuthor.login) ?? "unknown",
          name: text(commentAuthor.login) ?? "unknown",
          avatarUrl: avatarOf(commentAuthor)
        },
        body: text(comment.body) ?? "",
        createdAt: text(field(comment, "createdAt", "created_at")) ?? ""
      }
    })
  }
}

export const mapPrState = (raw: unknown, checks: ReadonlyArray<PrCheck>): SessionPrStatus | null => {
  const pr = jsonRecord(raw)
  const rawState = text(pr.state)?.toUpperCase()
  const merged = field(pr, "mergedAt", "merged_at") !== null && field(pr, "mergedAt", "merged_at") !== undefined
  const state: PrState | null = merged
    ? "merged"
    : rawState === "CLOSED"
      ? "closed"
      : rawState === "OPEN"
        ? field(pr, "isDraft", "draft") === true
          ? "draft"
          : "open"
        : null
  if (state === null) return null
  return {
    state,
    checks: state === "closed" || state === "merged" ? null : rollupChecks(checks)
  }
}

const headerNumber = (headers: Readonly<Record<string, string | undefined>>, name: string): number | null => {
  const raw = headers[name] ?? headers[name.toLowerCase()]
  if (raw === undefined) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export const mapRateLimit = (
  headers: Readonly<Record<string, string | undefined>>
): GitHubRateLimit => {
  const reset = headerNumber(headers, "x-ratelimit-reset")
  return {
    limit: headerNumber(headers, "x-ratelimit-limit"),
    remaining: headerNumber(headers, "x-ratelimit-remaining"),
    used: headerNumber(headers, "x-ratelimit-used"),
    resetAt: reset === null ? null : new Date(reset * 1_000).toISOString()
  }
}

const HUNK_RE = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/

interface DiffAnchorCursor {
  path: string | null
  newLine: number
  remaining: number
  inHunk: boolean
}

const consumeDiffHeader = (raw: string, cursor: DiffAnchorCursor): boolean => {
  if (raw.startsWith("diff --git ")) {
    cursor.path = null
    cursor.inHunk = false
    return true
  }
  if (!cursor.inHunk && raw.startsWith("+++ ")) {
    const target = raw.slice(4).trim()
    cursor.path = target === "/dev/null" ? null : target.replace(/^b\//, "")
    return true
  }
  if (!cursor.inHunk && raw.startsWith("--- ")) return true
  const hunk = HUNK_RE.exec(raw)
  if (!hunk) return false
  cursor.inHunk = true
  cursor.newLine = Number(hunk[1])
  cursor.remaining = hunk[2] === undefined ? 1 : Number(hunk[2])
  return true
}

const recordHunkLine = (
  raw: string,
  cursor: DiffAnchorCursor,
  output: Map<string, Set<number>>
): void => {
  if (!cursor.inHunk || cursor.path === null || raw.startsWith("-")) return
  if (raw.startsWith("+") || raw.startsWith(" ") || raw.length === 0) {
    if (cursor.remaining <= 0) {
      cursor.inHunk = false
      return
    }
    const lines = output.get(cursor.path) ?? new Set<number>()
    lines.add(cursor.newLine)
    output.set(cursor.path, lines)
    cursor.newLine += 1
    cursor.remaining -= 1
  } else if (!raw.startsWith("\\")) {
    cursor.inHunk = false
  }
}

/** Every NEW-side line GitHub accepts as an inline-review anchor. */
export const postableLines = (diff: string): ReadonlyMap<string, ReadonlySet<number>> => {
  const output = new Map<string, Set<number>>()
  const cursor: DiffAnchorCursor = { path: null, newLine: 0, remaining: 0, inHunk: false }
  for (const raw of diff.split("\n")) {
    if (!consumeDiffHeader(raw, cursor)) recordHunkLine(raw, cursor, output)
  }
  return output
}

/** Webhook names that invalidate installation/repository access caches. */
export const GITHUB_ACCESS_WEBHOOKS = [
  "installation.created",
  "installation.deleted",
  "installation.suspend",
  "installation.unsuspend",
  "installation_repositories.added",
  "installation_repositories.removed"
] as const satisfies ReadonlyArray<EmitterWebhookEventName>

export const isGitHubAccessWebhook = (event: string): boolean => {
  try {
    validateEventName(event)
  } catch {
    return false
  }
  return (GITHUB_ACCESS_WEBHOOKS as ReadonlyArray<string>).includes(event)
}
