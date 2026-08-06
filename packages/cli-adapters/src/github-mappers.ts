import type {
  GitHubRateLimit,
  Issue,
  IssueSummary,
  PrCheck,
  PrCheckStatus,
  PrFileChange,
  PrLabel,
  PrReviewKind,
  PrReviewer,
  PrReviewThread,
  PrState,
  PrThreadComment,
  PrSummary,
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

const labelsOf = (value: unknown): ReadonlyArray<PrLabel> =>
  rows(value).map((label) => ({
    name: text(label.name) ?? "",
    color: text(label.color)
  }))

const avatarOf = (value: Json): string | null =>
  text(field(value, "avatarUrl", "avatar_url"))

const mergeStateOf = (pr: Json): string | null => {
  const explicit = text(field(pr, "mergeStateStatus", "merge_state_status"))
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
  const files = rows(pr.files)

  const reviewerStates = new Map<string, PrReviewKind>()
  for (const review of reviews) {
    const login = nestedLogin(review.author ?? review.user)
    const reviewState = text(review.state)?.toUpperCase()
    if (!login || reviewState === "PENDING" || reviewState === "DISMISSED") continue
    reviewerStates.set(login, reviewKindOf(reviewState ?? null))
  }
  for (const requestedReviewer of requested) {
    const login = text(requestedReviewer.login) ?? text(requestedReviewer.name)
    if (login && !reviewerStates.has(login)) reviewerStates.set(login, "pending")
  }
  const reviewers: ReadonlyArray<PrReviewer> = [...reviewerStates].map(([login, reviewerState]) => ({
    login,
    state: reviewerState
  }))

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

  const author = jsonRecord(pr.author ?? pr.user)
  const head = jsonRecord(pr.head)
  const base = jsonRecord(pr.base)
  return {
    number: integer(pr.number) ?? 0,
    state,
    title: text(pr.title) ?? "",
    body: text(pr.body),
    url: text(field(pr, "url", "html_url")) ?? "",
    headRefName: text(field(pr, "headRefName", "head_ref")) ?? text(head.ref) ?? "",
    baseRefName: text(field(pr, "baseRefName", "base_ref")) ?? text(base.ref) ?? "",
    isDraft,
    author: { login: text(author.login) ?? "unknown", avatarUrl: avatarOf(author) },
    createdAt: text(field(pr, "createdAt", "created_at")) ?? "",
    commits: integer(pr.commits) ?? rows(pr.commits).length,
    changedFiles: integer(field(pr, "changedFiles", "changed_files")) ?? files.length,
    additions: integer(pr.additions) ?? 0,
    deletions: integer(pr.deletions) ?? 0,
    labels: labelsOf(pr.labels),
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

export const mapIssueSummary = (raw: unknown): IssueSummary => {
  const issue = jsonRecord(raw)
  const author = jsonRecord(issue.author ?? issue.user)
  return {
    number: integer(issue.number) ?? 0,
    title: text(issue.title) ?? "",
    url: text(field(issue, "url", "html_url")) ?? "",
    body: text(issue.body) ?? "",
    labels: labelsOf(issue.labels),
    author: { login: text(author.login) ?? "unknown", avatarUrl: avatarOf(author) },
    assignees: rows(issue.assignees).map((assignee) => ({
      login: text(assignee.login) ?? "unknown",
      avatarUrl: avatarOf(assignee)
    })),
    updatedAt: text(field(issue, "updatedAt", "updated_at")) ?? ""
  }
}

export const mapIssue = (raw: unknown): Issue => {
  const issue = jsonRecord(raw)
  const author = jsonRecord(issue.author ?? issue.user)
  return {
    number: integer(issue.number) ?? 0,
    title: text(issue.title) ?? "",
    url: text(field(issue, "url", "html_url")) ?? "",
    state: text(issue.state)?.toUpperCase() === "CLOSED" ? "closed" : "open",
    body: text(issue.body) ?? "",
    author: { login: text(author.login) ?? "unknown", avatarUrl: avatarOf(author) },
    assignees: rows(issue.assignees).map((assignee) => ({
      login: text(assignee.login) ?? "unknown",
      avatarUrl: avatarOf(assignee)
    })),
    labels: labelsOf(issue.labels),
    createdAt: text(field(issue, "createdAt", "created_at")) ?? "",
    comments: rows(issue.comments).map((comment) => {
      const commentAuthor = jsonRecord(comment.author ?? comment.user)
      return {
        author: { login: text(commentAuthor.login) ?? "unknown", avatarUrl: avatarOf(commentAuthor) },
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

/** Every NEW-side line GitHub accepts as an inline-review anchor. */
export const postableLines = (diff: string): ReadonlyMap<string, ReadonlySet<number>> => {
  const output = new Map<string, Set<number>>()
  let path: string | null = null
  let newLine = 0
  let remaining = 0
  let inHunk = false
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      path = null
      inHunk = false
      continue
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim()
      path = target === "/dev/null" ? null : target.replace(/^b\//, "")
      continue
    }
    if (!inHunk && raw.startsWith("--- ")) continue
    const hunk = HUNK_RE.exec(raw)
    if (hunk) {
      inHunk = true
      newLine = Number(hunk[1])
      remaining = hunk[2] === undefined ? 1 : Number(hunk[2])
      continue
    }
    if (!inHunk || path === null) continue
    if (raw.startsWith("-")) continue
    if (raw.startsWith("+") || raw.startsWith(" ") || raw.length === 0) {
      if (remaining <= 0) {
        inHunk = false
        continue
      }
      const lines = output.get(path) ?? new Set<number>()
      lines.add(newLine)
      output.set(path, lines)
      newLine += 1
      remaining -= 1
    } else if (!raw.startsWith("\\")) {
      inHunk = false
    }
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
