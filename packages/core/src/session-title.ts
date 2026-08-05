import type { Message } from "./conversation.js"

/**
 * Pure helpers for auto-generating a session's title from its transcript. Kept
 * free of Effect/SDK deps so they're trivially unit-tested; the impure one-shot
 * LLM call (cli-adapters `session-title-service`) is a thin wrapper that funnels
 * both its output and its fallback through `cleanTitle`.
 */

/** The provisional title a session carries until the agent names it. */
export const UNTITLED_SESSION = "Untitled session"

export const SEMANTIC_BRANCH_TYPES = [
  "feat", "fix", "refactor", "docs", "test", "chore",
  "perf", "build", "ci", "style", "revert"
] as const
export type SemanticBranchType = (typeof SEMANTIC_BRANCH_TYPES)[number]
export interface SemanticBranchProposal {
  readonly type: SemanticBranchType
  readonly slug: string
}
export interface SessionMetadataProposal {
  readonly title: string
  readonly branch: SemanticBranchProposal
}

const semanticTypes = new Set<string>(SEMANTIC_BRANCH_TYPES)
export const MAX_SEMANTIC_BRANCH_SLUG_LENGTH = 80
export const MAX_SEMANTIC_BRANCH_NAME_LENGTH = 96

/**
 * These are not useful task slugs and are easy to mistake for git's own ref
 * namespaces/files when read in logs or recovery tooling. The model never gets
 * to opt back into one by changing case because validation happens after
 * canonicalisation.
 */
const RESERVED_BRANCH_SLUGS = new Set([
  "head",
  "refs",
  "heads",
  "remotes",
  "tags",
  "objects",
  "logs",
  "packed-refs"
])
const DANGEROUS_BRANCH_SYNTAX = /[~^:?*[\]\\;|&$`<>"']/

/** Ref- and shell-shaped input is invalid rather than merely cosmetically noisy. */
const hasDangerousBranchSyntax = (raw: string): boolean =>
  [...raw].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  }) ||
  DANGEROUS_BRANCH_SYNTAX.test(raw) ||
  raw.includes("..") ||
  raw.includes("@{")

const normalizedBranchSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const fallbackBranchSlug = (source: string): string => {
  const slug = normalizedBranchSlug(source)
    .slice(0, MAX_SEMANTIC_BRANCH_SLUG_LENGTH)
    .replace(/-+$/g, "")
  return slug.length > 0 && !RESERVED_BRANCH_SLUGS.has(slug) ? slug : "task"
}

/** Normalize untrusted model text into the safe slug half of a git branch. */
export const cleanBranchSlug = (raw: string): string =>
  normalizedBranchSlug(raw)
    .slice(0, MAX_SEMANTIC_BRANCH_SLUG_LENGTH)
    .replace(/-+$/g, "")

/** Validate structured model output, falling back to a deterministic chore branch. */
export const cleanSemanticBranchProposal = (
  raw: { readonly type?: unknown; readonly slug?: unknown } | null | undefined,
  fallbackSource: string
): SemanticBranchProposal => {
  const normalizedType = typeof raw?.type === "string"
    ? raw.type.trim().toLowerCase()
    : ""
  const rawSlug = typeof raw?.slug === "string" ? raw.slug : ""
  const proposed = normalizedBranchSlug(rawSlug)
  const valid = semanticTypes.has(normalizedType) &&
    rawSlug.trim().length > 0 &&
    !hasDangerousBranchSyntax(rawSlug) &&
    proposed.length > 0 &&
    proposed.length <= MAX_SEMANTIC_BRANCH_SLUG_LENGTH &&
    !RESERVED_BRANCH_SLUGS.has(proposed)
  return valid
    ? { type: normalizedType as SemanticBranchType, slug: proposed }
    : { type: "chore", slug: fallbackBranchSlug(fallbackSource) }
}

export const semanticBranchName = (proposal: SemanticBranchProposal): string =>
  `${proposal.type}/${proposal.slug}`

/** Decode only a canonical semantic ref; useful when recovering after a crash. */
export const semanticBranchProposalFromName = (
  branch: string
): SemanticBranchProposal | null => {
  if (branch.length > MAX_SEMANTIC_BRANCH_NAME_LENGTH) return null
  const slash = branch.indexOf("/")
  if (slash <= 0 || slash !== branch.lastIndexOf("/")) return null
  const type = branch.slice(0, slash)
  const slug = branch.slice(slash + 1)
  if (!semanticTypes.has(type) ||
    slug.length === 0 ||
    slug.length > MAX_SEMANTIC_BRANCH_SLUG_LENGTH ||
    slug !== normalizedBranchSlug(slug) ||
    RESERVED_BRANCH_SLUGS.has(slug)) return null
  return { type: type as SemanticBranchType, slug }
}

/** The concatenated text of a message's `Text` parts. */
const textOf = (message: Message): string =>
  message.parts
    .filter((p): p is Extract<typeof p, { _tag: "Text" }> => p._tag === "Text")
    .map((p) => p.text)
    .join(" ")
    .trim()

/**
 * Normalize a raw model/first-message title into a single clean line: collapse
 * whitespace/newlines, strip surrounding quotes and a trailing period, and clamp
 * to `maxLen` on a word boundary. Empty input → `UNTITLED_SESSION`.
 */
export const cleanTitle = (raw: string, maxLen = 60): string => {
  let t = raw.replace(/\s+/g, " ").trim()
  // Strip a single layer of surrounding quotes (straight or curly).
  const quotes = new Set(['"', "'", "“", "”", "‘", "’"])
  while (t.length >= 2 && quotes.has(t[0]!) && quotes.has(t[t.length - 1]!)) {
    t = t.slice(1, -1).trim()
  }
  t = t.replace(/[.]+$/, "").trim()
  if (t.length === 0) return UNTITLED_SESSION
  if (t.length <= maxLen) return t
  const clamped = t.slice(0, maxLen)
  const lastSpace = clamped.lastIndexOf(" ")
  return (lastSpace > maxLen * 0.5 ? clamped.slice(0, lastSpace) : clamped).trim() + "…"
}

/** The first user message's text, or "". */
const firstUserText = (messages: ReadonlyArray<Message>): string => {
  const first = messages.find((m) => m.role === "user" && textOf(m).length > 0)
  return first ? textOf(first) : ""
}

/**
 * Deterministic fallback title (no LLM): the first user message, cleaned. Used
 * when the titling model is unavailable/errors or returns nothing. Empty
 * transcript → `UNTITLED_SESSION`.
 */
export const fallbackTitle = (messages: ReadonlyArray<Message>): string => {
  const text = firstUserText(messages)
  return text.length > 0 ? cleanTitle(text) : UNTITLED_SESSION
}

/**
 * The prompt handed to the titling model: the request that started the session
 * plus a short slice of the latest assistant reply, with strict instructions to
 * answer with only a terse title. Pure + deterministic for a given transcript.
 */
export const buildTitlePrompt = (messages: ReadonlyArray<Message>): string => {
  const firstUser = firstUserText(messages).slice(0, 800)
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && textOf(m).length > 0)
  const assistantSlice = lastAssistant ? textOf(lastAssistant).slice(0, 400) : ""
  return [
    "Describe this coding session with a concise 3-6 word title and a semantic git branch.",
    `Branch type must be one of: ${SEMANTIC_BRANCH_TYPES.join(", ")}.`,
    "Branch slug must be concise kebab-case and describe the actual work.",
    'Reply with ONLY JSON in this shape: {"title":"...","branch":{"type":"feat","slug":"..."}}.',
    "",
    `User's request:\n${firstUser}`,
    ...(assistantSlice ? ["", `Agent's latest reply (for context):\n${assistantSlice}`] : [])
  ].join("\n")
}
