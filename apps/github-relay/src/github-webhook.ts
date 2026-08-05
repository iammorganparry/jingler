import { RELAY_POLICY } from "./env.js"

export type SupportedGitHubEvent =
  | "pull_request_review"
  | "pull_request_review_comment"
  | "issue_comment"
  | "pull_request"
  | "check_run"
  | "check_suite"
  | "status"

export interface NormalizedGitHubEvent {
  readonly version: 1
  readonly deliveryId: string
  readonly semanticKey: string
  readonly event: SupportedGitHubEvent
  readonly action: string
  readonly installationId: string
  readonly repository: {
    readonly id: string
    readonly owner: string
    readonly name: string
    readonly fullName: string
  }
  readonly pullRequest: {
    readonly id: string
    readonly number: number
    readonly title: string
    readonly url: string
    readonly headSha: string
    readonly baseSha: string
  } | null
  readonly actor: {
    readonly id: string
    readonly login: string
    readonly type: string
  }
  readonly feedback: {
    readonly kind: "review" | "review-comment" | "issue-comment"
    readonly id: string
    readonly body: string
    readonly state: string | null
    readonly path: string | null
    readonly line: number | null
    readonly side: string | null
  } | null
  readonly actionable: boolean
  readonly occurredAt: string
}

export class WebhookBodyTooLargeError extends Error {}

const encoder = new TextEncoder()

const bytesFromHex = (value: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2))
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16)
  }
  return bytes
}

/** GitHub's sha256 signature check, performed over the exact unparsed request bytes. */
export const verifyGitHubWebhookSignature = async (
  body: ArrayBuffer,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> => {
  if (!signatureHeader?.startsWith("sha256=") || secret.length === 0) return false
  const signature = bytesFromHex(signatureHeader.slice("sha256=".length))
  if (!signature) return false
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  )
  return crypto.subtle.verify("HMAC", key, signature, body)
}

export const readBoundedWebhookBody = async (
  request: Request,
  maximumBytes = RELAY_POLICY.maxWebhookBytes
): Promise<ArrayBuffer> => {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new WebhookBodyTooLargeError()
  }
  if (!request.body) return new ArrayBuffer(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) throw new WebhookBodyTooLargeError()
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const string = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

const identifier = (value: unknown): string | null =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" && value.length > 0
      ? value
      : null

const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null

const digest = async (value: string): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value))
  return [...new Uint8Array(hash)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

const feedbackFrom = (
  event: SupportedGitHubEvent,
  payload: Record<string, unknown>
): NormalizedGitHubEvent["feedback"] => {
  const sourceName =
    event === "pull_request_review"
      ? "review"
      : event === "pull_request_review_comment"
        ? "comment"
        : event === "issue_comment"
          ? "comment"
          : null
  if (!sourceName) return null
  const source = record(payload[sourceName])
  const id = identifier(source?.id)
  const body = string(source?.body)?.trim()
  if (!source || !id || !body) return null
  return {
    kind:
      event === "pull_request_review"
        ? "review"
        : event === "pull_request_review_comment"
          ? "review-comment"
          : "issue-comment",
    id,
    body,
    state: string(source.state),
    path: string(source.path),
    line: integer(source.line ?? source.original_line),
    side: string(source.side)
  }
}

const pullRequestFrom = (
  payload: Record<string, unknown>
): NormalizedGitHubEvent["pullRequest"] => {
  const issue = record(payload.issue)
  const pullRequest = record(payload.pull_request)
  if (!pullRequest && !record(issue?.pull_request)) return null
  const source = pullRequest ?? issue
  const id = identifier(source?.id)
  const number = integer(source?.number)
  if (!source || !id || number === null) return null
  const head = record(source.head)
  const base = record(source.base)
  return {
    id,
    number,
    title: string(source.title) ?? "",
    url: string(source.html_url) ?? "",
    headSha: string(head?.sha) ?? "",
    baseSha: string(base?.sha) ?? ""
  }
}

const SUPPORTED_EVENTS = new Set<SupportedGitHubEvent>([
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "pull_request",
  "check_run",
  "check_suite",
  "status"
])

export const normalizeGitHubWebhook = async (input: {
  readonly deliveryId: string
  readonly eventName: string
  readonly payload: unknown
}): Promise<NormalizedGitHubEvent | null> => {
  if (!SUPPORTED_EVENTS.has(input.eventName as SupportedGitHubEvent)) return null
  const event = input.eventName as SupportedGitHubEvent
  const payload = record(input.payload)
  const installation = record(payload?.installation)
  const repository = record(payload?.repository)
  const owner = record(repository?.owner)
  const sender = record(payload?.sender)
  const installationId = identifier(installation?.id)
  const repositoryId = identifier(repository?.id)
  const repositoryName = string(repository?.name)
  const repositoryOwner = string(owner?.login)
  const actorId = identifier(sender?.id)
  const actorLogin = string(sender?.login)
  const actorType = string(sender?.type)
  const action =
    string(payload?.action) ?? (event === "status" ? string(payload?.state) : null) ?? "unknown"
  if (
    !payload ||
    !installationId ||
    !repository ||
    !repositoryId ||
    !repositoryName ||
    !repositoryOwner ||
    !actorId ||
    !actorLogin ||
    !actorType
  ) {
    return null
  }
  const feedback = feedbackFrom(event, payload)
  const pullRequest = event === "status" ? null : pullRequestFrom(payload)
  if (event === "issue_comment" && !pullRequest) return null
  const human = actorType.toLocaleLowerCase("en-US") === "user"
  const actionableAction =
    (event === "pull_request_review" && action === "submitted") ||
    ((event === "pull_request_review_comment" || event === "issue_comment") &&
      action === "created")
  const actionable = human && actionableAction && feedback !== null
  const occurrence =
    (event === "status"
      ? string(payload.updated_at) ?? string(payload.created_at)
      : string(record(payload.review)?.submitted_at) ??
        string(record(payload.comment)?.created_at) ??
        string(record(payload.pull_request)?.updated_at) ??
        string(record(payload.check_run)?.updated_at) ??
        string(record(payload.check_suite)?.updated_at)) ??
    new Date().toISOString()
  const semanticSource = feedback
    ? `${event}:${feedback.id}:${feedback.state ?? ""}:${feedback.body}`
    : `${event}:${action}:${pullRequest?.id ?? repositoryId}:${occurrence}`
  return {
    version: 1,
    deliveryId: input.deliveryId,
    semanticKey: await digest(semanticSource),
    event,
    action,
    installationId,
    repository: {
      id: repositoryId,
      owner: repositoryOwner,
      name: repositoryName,
      fullName: string(repository.full_name) ?? `${repositoryOwner}/${repositoryName}`
    },
    pullRequest,
    actor: { id: actorId, login: actorLogin, type: actorType },
    feedback,
    actionable,
    occurredAt: occurrence
  }
}
