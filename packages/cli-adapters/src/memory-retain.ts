export interface MemoryRetentionInput {
  readonly sessionId: string
  readonly chatId: string
  /** Stable assistant message id: the idempotency boundary for one settled turn. */
  readonly turnId: string
  readonly repository: string
  readonly userText: string
  readonly assistantText: string
  readonly settledAt: string
}

const MAX_USER_CHARACTERS = 3_000
const MAX_ASSISTANT_CHARACTERS = 4_000
const MAX_RETENTION_CHARACTERS = 8_000

const clipped = (value: string, maxCharacters: number): string =>
  value.length <= maxCharacters
    ? value
    : `${value.slice(0, maxCharacters)}\n[TRUNCATED]`

/** Stable non-secret input for the organization-scoped retention digest. */
export const memoryRetentionIdentity = (
  input: Pick<MemoryRetentionInput, "sessionId" | "chatId" | "turnId">
): string => [input.sessionId, input.chatId, input.turnId].join("\u0000")

/**
 * Render only canonical visible provenance. Callers supply the network-boundary
 * sanitizer so prompts, tools, recalled context, and child transcripts cannot
 * enter this function in the first place.
 */
export const memoryRetentionContent = (
  input: MemoryRetentionInput,
  sanitize: (value: string) => string
): string => {
  const user = clipped(sanitize(input.userText).trim(), MAX_USER_CHARACTERS)
  const assistant = clipped(
    sanitize(input.assistantText).trim(),
    MAX_ASSISTANT_CHARACTERS
  )
  return clipped(
    [
      `Repository: ${sanitize(input.repository).trim()}`,
      `Settled at: ${input.settledAt}`,
      "",
      "User input:",
      user,
      "",
      "Assistant outcome:",
      assistant
    ].join("\n"),
    MAX_RETENTION_CHARACTERS
  )
}
