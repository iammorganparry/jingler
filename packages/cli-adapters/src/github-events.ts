import { FileSystem, Path } from "@effect/platform"
import type { GitHubRelayEvent, GitHubRelayEventName } from "@jingler/core"
import { GitError } from "@jingler/core"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"

/**
 * Desktop-side mirror of the relay's versioned, normalized event contract.
 *
 * This module intentionally accepts `unknown` at the transport boundary. A
 * webhook payload must never leak through to renderer/session code merely
 * because a websocket frame happened to contain JSON.
 */
export type { GitHubRelayEvent, GitHubRelayEventName } from "@jingler/core"

export type GitHubRelayServerMessage =
  | { readonly type: "hello"; readonly cursor: number; readonly newestCursor: number }
  | { readonly type: "event"; readonly cursor: number; readonly event: GitHubRelayEvent }
  // A well-formed event envelope whose payload this client cannot decode. The
  // cursor is known and trustworthy, so the consumer advances past it rather
  // than closing the socket — a permanently-unparseable frame must not replay
  // forever. Distinct from `null` (a malformed envelope with no usable cursor).
  | { readonly type: "event-skip"; readonly cursor: number }
  | { readonly type: "replay-more"; readonly cursor: number }
  | { readonly type: "pong"; readonly at: number }
  | { readonly type: "error"; readonly code: string }

export type GitHubRelayClientMessage =
  | { readonly type: "ack"; readonly cursor: number }
  | { readonly type: "resume"; readonly cursor: number }
  | { readonly type: "ping" }

export interface GitHubFeedbackTarget {
  readonly sessionId: string
  readonly chatId: string
  readonly installationId: string
  readonly repositoryId: string
  readonly prNumber: number
  readonly archived: boolean
}

export interface GitHubDeliveryLedger {
  readonly deliveryIds: ReadonlyArray<string>
  readonly semanticKeys: ReadonlyArray<string>
}

const EVENTS = new Set<GitHubRelayEventName>([
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "pull_request",
  "check_run",
  "check_suite",
  "status"
])

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string"

const cursor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const finiteInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value)

const parseFeedback = (value: unknown): GitHubRelayEvent["feedback"] | undefined => {
  if (value === null) return null
  const candidate = object(value)
  if (
    !candidate ||
    (candidate.kind !== "review" &&
      candidate.kind !== "review-comment" &&
      candidate.kind !== "issue-comment") ||
    !nonEmptyString(candidate.id) ||
    !nonEmptyString(candidate.body) ||
    !nullableString(candidate.state) ||
    !nullableString(candidate.path) ||
    !(candidate.line === null || finiteInteger(candidate.line)) ||
    !nullableString(candidate.side)
  ) {
    return 
  }
  return {
    kind: candidate.kind,
    id: candidate.id,
    body: candidate.body,
    state: candidate.state,
    path: candidate.path,
    line: candidate.line,
    side: candidate.side
  }
}

const validRepository = (
  value: Record<string, unknown> | null
): value is GitHubRelayEvent["repository"] =>
  value !== null &&
  nonEmptyString(value.id) &&
  nonEmptyString(value.owner) &&
  nonEmptyString(value.name) &&
  nonEmptyString(value.fullName)

const validActor = (value: Record<string, unknown> | null): value is GitHubRelayEvent["actor"] =>
  value !== null &&
  nonEmptyString(value.id) &&
  nonEmptyString(value.login) &&
  nonEmptyString(value.type)

const validEventMetadata = (
  value: Record<string, unknown> | null
): value is Record<string, unknown> &
  Pick<
    GitHubRelayEvent,
    | "version"
    | "deliveryId"
    | "semanticKey"
    | "event"
    | "action"
    | "installationId"
    | "actionable"
    | "occurredAt"
  > =>
  value !== null &&
  value.version === 1 &&
  nonEmptyString(value.deliveryId) &&
  nonEmptyString(value.semanticKey) &&
  EVENTS.has(value.event as GitHubRelayEventName) &&
  nonEmptyString(value.action) &&
  nonEmptyString(value.installationId) &&
  typeof value.actionable === "boolean" &&
  nonEmptyString(value.occurredAt) &&
  Number.isFinite(Date.parse(value.occurredAt))

const validPullRequest = (value: Record<string, unknown>): boolean =>
  nonEmptyString(value.id) &&
  finiteInteger(value.number) &&
  nonEmptyString(value.url) &&
  // CI events legitimately carry an empty title and empty SHAs.
  typeof value.title === "string" &&
  typeof value.headSha === "string" &&
  typeof value.baseSha === "string"

const decodeServerMessage = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export const parseGitHubRelayEvent = (value: unknown): GitHubRelayEvent | null => {
  const candidate = object(value)
  const repository = object(candidate?.repository)
  const actor = object(candidate?.actor)
  const pr = candidate?.pullRequest === null ? null : object(candidate?.pullRequest)
  const feedback = parseFeedback(candidate?.feedback)
  if (
    !validEventMetadata(candidate) ||
    !validRepository(repository) ||
    !validActor(actor) ||
    feedback === undefined
  ) {
    return null
  }
  if (
    pr !== null && !validPullRequest(pr)) return null
  return {
    version: 1,
    deliveryId: candidate.deliveryId,
    semanticKey: candidate.semanticKey,
    event: candidate.event as GitHubRelayEventName,
    action: candidate.action,
    installationId: candidate.installationId,
    repository: {
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName
    },
    pullRequest:
      pr === null
        ? null
        : {
            id: pr.id as string,
            number: pr.number as number,
            title: pr.title as string,
            url: pr.url as string,
            headSha: pr.headSha as string,
            baseSha: pr.baseSha as string
          },
    actor: { id: actor.id, login: actor.login, type: actor.type },
    feedback,
    actionable: candidate.actionable,
    occurredAt: candidate.occurredAt
  }
}

export const parseGitHubRelayServerMessage = (raw: unknown): GitHubRelayServerMessage | null => {
  const candidate = object(decodeServerMessage(raw))
  if (!(candidate && nonEmptyString(candidate.type))) return null
  if (
    candidate.type === "hello" &&
    cursor(candidate.cursor) &&
    cursor(candidate.newestCursor)
  ) {
    return { type: "hello", cursor: candidate.cursor, newestCursor: candidate.newestCursor }
  }
  if (candidate.type === "event" && cursor(candidate.cursor)) {
    const event = parseGitHubRelayEvent(candidate.event)
    return event
      ? { type: "event", cursor: candidate.cursor, event }
      : { type: "event-skip", cursor: candidate.cursor }
  }
  if (candidate.type === "replay-more" && cursor(candidate.cursor)) {
    return { type: "replay-more", cursor: candidate.cursor }
  }
  if (candidate.type === "pong" && typeof candidate.at === "number" && Number.isFinite(candidate.at)) {
    return { type: "pong", at: candidate.at }
  }
  if (candidate.type === "error" && nonEmptyString(candidate.code)) {
    return { type: "error", code: candidate.code }
  }
  return null
}

export const encodeGitHubRelayClientMessage = (message: GitHubRelayClientMessage): string =>
  JSON.stringify(message)

/** Exact installation/repository/PR routing; absent identity never becomes a wildcard. */
export const findGitHubFeedbackTarget = (
  event: GitHubRelayEvent,
  targets: ReadonlyArray<GitHubFeedbackTarget>
): GitHubFeedbackTarget | null => {
  const prNumber = event.pullRequest?.number
  if (prNumber === undefined) return null
  return (
    targets.find(
      (target) =>
        !target.archived &&
        target.installationId === event.installationId &&
        target.repositoryId === event.repository.id &&
        target.prNumber === prNumber
    ) ?? null
  )
}

/**
 * Claim before dispatch and persist the returned ledger. This deliberately
 * favours never creating two agent turns after a crash over silently retrying a
 * turn whose local dispatch outcome is unknowable.
 */
export const claimGitHubDelivery = (
  ledger: GitHubDeliveryLedger,
  event: Pick<GitHubRelayEvent, "deliveryId" | "semanticKey">,
  maximumEntries = 2_048
): { readonly duplicate: boolean; readonly ledger: GitHubDeliveryLedger } => {
  if (
    ledger.deliveryIds.includes(event.deliveryId) ||
    ledger.semanticKeys.includes(event.semanticKey)
  ) {
    return { duplicate: true, ledger }
  }
  const keep = Math.max(1, maximumEntries)
  return {
    duplicate: false,
    ledger: {
      deliveryIds: [...ledger.deliveryIds, event.deliveryId].slice(-keep),
      semanticKeys: [...ledger.semanticKeys, event.semanticKey].slice(-keep)
    }
  }
}

const clean = (value: string, maximum: number): string =>
  [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
    })
    .join("")
    .trim()
    .slice(0, maximum)

export const githubFeedbackInstruction = (event: GitHubRelayEvent): string | null => {
  if (!((event.actionable && event.feedback ) && event.pullRequest)) return null
  const feedback = event.feedback
  const location = feedback.path
    ? `\nLocation: ${clean(feedback.path, 1_024)}${feedback.line === null ? "" : `:${feedback.line}`}${feedback.side ? ` (${clean(feedback.side, 32)})` : ""}`
    : ""
  return [
    `GitHub feedback from @${clean(event.actor.login, 256)} on ${clean(event.repository.fullName, 512)}#${event.pullRequest.number}.${location}`,
    "",
    "<github-feedback>",
    clean(feedback.body, 32_000),
    "</github-feedback>",
    "",
    'Address this feedback in the current session. Keep the response and any code changes visible in this conversation. Do NOT post any comment, reply, or acknowledgement back to GitHub (no "Addressed in …" replies) — a comment posted to the PR loops back in as new feedback. Once the feedback is genuinely addressed you MAY mark its review thread resolved (resolution posts no comment, so nothing loops back); leave it open if the feedback still needs the reviewer\'s judgement.',
    "",
    // Plan-execution sessions are told to fold NEW WORK into an amended plan.
    // Review feedback on work already produced is not new scope, and amending
    // the plan per comment churned the plan card (proposed → stale, over and
    // over) while the actual fix waited. Override that reflex explicitly.
    "If this session is executing an approved plan: this feedback is review input on work the plan already produced, not new scope. Fix it directly — do NOT submit a plan revision or amendment for it. Only amend the plan if the feedback genuinely invalidates a stage that has not run yet."
  ].join("\n")
}

const RelayCursorState = Schema.Struct({
  version: Schema.Literal(1),
  deviceId: Schema.String,
  cursors: Schema.Record({ key: Schema.String, value: Schema.Number })
})
type RelayCursorState = Schema.Schema.Type<typeof RelayCursorState>

/** Main-process durable identity and acknowledged cursor store. */
export class GitHubEventStore extends Effect.Service<GitHubEventStore>()(
  "@jingler/GitHubEventStore",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const paths = yield* AppPaths
      const file = path.join(paths.root, "github-relay.json")
      const temporary = `${file}.tmp`
      const lock = Effect.unsafeMakeSemaphore(1)
      const empty = (): RelayCursorState => ({
        version: 1,
        deviceId: crypto.randomUUID(),
        cursors: {}
      })
      const read = fs.readFileString(file).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknown(Schema.parseJson(RelayCursorState))(raw)),
        Effect.orElseSucceed(empty)
      )
      const write = (state: RelayCursorState) =>
        fs.makeDirectory(paths.root, { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(temporary, JSON.stringify(state))),
          Effect.andThen(fs.rename(temporary, file)),
          Effect.mapError(
            (cause) => new GitError({ message: "Failed to persist GitHub relay cursor", cause })
          )
        )
      const mutate = <A>(operation: (state: RelayCursorState) => readonly [A, RelayCursorState]) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* read
            const [result, next] = operation(current)
            if (next !== current) yield* write(next)
            return result
          })
        )
      return {
        clientId: (installationId: string) =>
          mutate((state) => [`${state.deviceId}:${installationId}`, state] as const),
        cursor: (clientId: string) =>
          mutate((state) => [state.cursors[clientId] ?? 0, state] as const),
        setCursor: (clientId: string, cursor: number) =>
          mutate((state) => {
            if ((state.cursors[clientId] ?? 0) >= cursor) return [undefined, state] as const
            return [
              undefined,
              { ...state, cursors: { ...state.cursors, [clientId]: cursor } }
            ] as const
          })
      } as const
    })
  }
) {}
