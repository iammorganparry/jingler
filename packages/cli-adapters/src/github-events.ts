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

export const parseGitHubRelayEvent = (value: unknown): GitHubRelayEvent | null => {
  const candidate = object(value)
  const repository = object(candidate?.repository)
  const actor = object(candidate?.actor)
  const pr = candidate?.pullRequest === null ? null : object(candidate?.pullRequest)
  const feedback = parseFeedback(candidate?.feedback)
  if (
    !candidate ||
    candidate.version !== 1 ||
    !nonEmptyString(candidate.deliveryId) ||
    !nonEmptyString(candidate.semanticKey) ||
    !EVENTS.has(candidate.event as GitHubRelayEventName) ||
    !nonEmptyString(candidate.action) ||
    !nonEmptyString(candidate.installationId) ||
    !repository ||
    !nonEmptyString(repository.id) ||
    !nonEmptyString(repository.owner) ||
    !nonEmptyString(repository.name) ||
    !nonEmptyString(repository.fullName) ||
    !actor ||
    !nonEmptyString(actor.id) ||
    !nonEmptyString(actor.login) ||
    !nonEmptyString(actor.type) ||
    feedback === undefined ||
    typeof candidate.actionable !== "boolean" ||
    !nonEmptyString(candidate.occurredAt) ||
    !Number.isFinite(Date.parse(candidate.occurredAt))
  ) {
    return null
  }
  if (
    pr !== null &&
    (!(((nonEmptyString(pr.id) &&finiteInteger(pr.number) ) &&nonEmptyString(pr.title) ) &&nonEmptyString(pr.url) ) ||
      typeof pr.headSha !== "string" ||
      typeof pr.baseSha !== "string")
  ) {
    return null
  }
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
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const candidate = object(value)
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
    return event ? { type: "event", cursor: candidate.cursor, event } : null
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
    "Address this feedback in the current session. Keep the response and any code changes visible in this conversation."
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
