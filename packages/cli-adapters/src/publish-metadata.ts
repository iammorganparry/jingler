import type { Message, PublishMetadata, Session } from "@jingler/core"
import { Effect } from "effect"
import { isScriptedEnv } from "./scripted.js"

const TYPES = "feat|fix|refactor|docs|test|chore|perf|build|ci|style|revert"
const COMMIT = new RegExp(`^(?:${TYPES})(?:\\([a-z0-9][a-z0-9._/-]{0,40}\\))?!?: [^\\r\\n]+$`)
const COMMIT_LIMIT = 72
const PR_TITLE_LIMIT = 120
const PR_BODY_LIMIT = 20_000

// Model output is prose, not a command surface. The mutation layer uses argv
// throughout, but rejecting command/credential-shaped prose as well keeps a
// hostile transcript from being copied into git history or a public PR.
const SHELL_SHAPED = /(?:\$\(|`|&&|\|\||(?:^|[\s;|&])(?:bash|sh|zsh|git|curl|wget|rm|touch|chmod|chown|sudo)\s)/i
const CREDENTIAL_SHAPED = /(?:\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/i

export interface PublishMetadataInput {
  readonly session: Session
  readonly messages: ReadonlyArray<Message>
  readonly changedPaths: ReadonlyArray<string>
  readonly diffSummary: string
}

export interface PublishMetadataGenerator {
  readonly generate: (input: PublishMetadataInput) => Effect.Effect<PublishMetadata>
}

const readableSlug = (session: Session): string =>
  (session.semanticBranchProposal?.slug ?? session.branch.split("/").at(-1) ?? "session-work")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/[-_]+/g, " ")
    .trim()

const hasControlCharacters = (value: string, multiline: boolean): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    if (multiline && (codePoint === 10 || codePoint === 13)) return false
    return codePoint < 32 || codePoint === 127
  })

const unsafeProse = (value: string, multiline: boolean): boolean =>
  hasControlCharacters(value, multiline) ||
  SHELL_SHAPED.test(value) ||
  CREDENTIAL_SHAPED.test(value)

export const isCommitSubjectSafe = (subject: string): boolean =>
  subject.length <= COMMIT_LIMIT &&
  COMMIT.test(subject) &&
  !unsafeProse(subject, false)

/** Revalidate generated or persisted metadata immediately before mutation. */
export const isPublishMetadataSafe = (metadata: PublishMetadata): boolean =>
  isCommitSubjectSafe(metadata.commitMessage) &&
  metadata.prTitle.length <= PR_TITLE_LIMIT &&
  metadata.prTitle.trim().length > 0 &&
  metadata.prBody.length <= PR_BODY_LIMIT &&
  metadata.prBody.trim().length > 0 &&
  !unsafeProse(metadata.prTitle, false) &&
  !unsafeProse(metadata.prBody, true)

const safeTitle = (value: string, fallback: string): string => {
  const title = value.replace(/\s+/g, " ").trim().slice(0, PR_TITLE_LIMIT)
  return title.length > 0 && !unsafeProse(title, false) ? title : fallback
}

const safePath = (value: string): string | null => {
  const path = value.replace(/[\r\n`]/g, "").trim().slice(0, 240)
  return path.length > 0 && !unsafeProse(path, false) ? path : null
}

export const fallbackPublishMetadata = (input: PublishMetadataInput): PublishMetadata => {
  const type = input.session.semanticBranchProposal?.type ?? "chore"
  const description = readableSlug(input.session).slice(0, 60) || "publish session work"
  const fallbackTitle = `Publish ${description}`.slice(0, PR_TITLE_LIMIT)
  const title = safeTitle(input.session.title, fallbackTitle)
  const paths = input.changedPaths.flatMap((path) => {
    const safe = safePath(path)
    return safe === null ? [] : [safe]
  }).slice(0, 12)
  return {
    commitMessage: `${type}: ${description}`,
    prTitle: title,
    prBody: [
      "## Summary",
      "",
      title,
      ...(paths.length > 0 ? ["", "## Changed files", "", ...paths.map((path) => `- \`${path}\``)] : []),
      "",
      "## Verification",
      "",
      "- Review the automated checks and the diff."
    ].join("\n")
  }
}

const string = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null

/** Decode hostile model output into bounded prose; mutation arguments never come from JSON structure. */
export const parsePublishMetadata = (
  raw: string,
  input: PublishMetadataInput
): PublishMetadata => {
  const fallback = fallbackPublishMetadata(input)
  try {
    const decoded = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Record<string, unknown>
    const metadata = {
      commitMessage: string(decoded.commitMessage) ?? "",
      prTitle: string(decoded.prTitle) ?? "",
      prBody: string(decoded.prBody) ?? ""
    }
    if (!isPublishMetadataSafe(metadata)) {
      return fallback
    }
    return metadata
  } catch {
    return fallback
  }
}

const textFromAssistant = (message: unknown): string => {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content)
    ? content.filter((part) => (part as { type?: unknown }).type === "text")
        .map((part) => String((part as { text?: unknown }).text ?? "")).join("\n")
    : ""
}

export const claudePublishMetadataGenerator: PublishMetadataGenerator = {
  generate: (input) =>
    isScriptedEnv()
      ? Effect.succeed(fallbackPublishMetadata(input))
      : Effect.tryPromise(async () => {
          const { query } = await import("@anthropic-ai/claude-agent-sdk")
          const transcript = input.messages.slice(-12).map((message) => JSON.stringify(message)).join("\n")
          const prompt = [
            "Return JSON only with commitMessage, prTitle, and prBody.",
            "commitMessage must be a Conventional Commit subject under 73 characters using feat, fix, refactor, docs, test, chore, perf, build, ci, style, or revert.",
            "Describe only the supplied work. Do not include commands, credentials, or markdown fences.",
            `Session: ${input.session.title}`,
            `Branch: ${input.session.branch}`,
            `Changed paths: ${input.changedPaths.join(", ")}`,
            `Diff summary:\n${input.diffSummary.slice(0, 8_000)}`,
            `Recent transcript:\n${transcript.slice(0, 12_000)}`
          ].join("\n\n")
          let output = ""
          for await (const message of query({
            prompt,
            options: { model: "haiku", allowedTools: [], maxTurns: 1, includePartialMessages: false }
          })) {
            if ((message as { type?: string }).type === "assistant") output += textFromAssistant(message)
            if ((message as { type?: string }).type === "result") break
          }
          return parsePublishMetadata(output, input)
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.orElseSucceed(() => fallbackPublishMetadata(input))
        )
}
