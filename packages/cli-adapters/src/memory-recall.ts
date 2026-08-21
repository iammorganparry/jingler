import type { Message } from "@jingler/core"
import { leadsWithCommand } from "./turn-prompt.js"

export interface MemoryRecallTurn {
  readonly role: "user" | "assistant"
  readonly text: string
}

export interface MemoryRecallQueryInput {
  readonly operatorText: string
  readonly repo: string
  readonly branch: string
  readonly recentTurns?: ReadonlyArray<MemoryRecallTurn>
}

/** Select bounded canonical transcript text; tool, prompt, and injected context are not parts. */
export const recentMemoryRecallTurns = (
  messages: ReadonlyArray<Message>
): ReadonlyArray<MemoryRecallTurn> =>
  messages
    .map((message) => ({
      role: message.role,
      text: message.parts
        .filter((part) => part._tag === "Text")
        .map((part) => part.text)
        .join("\n")
    }))
    .filter(({ text }) => text.trim().length > 0)
    .slice(-3)

/**
 * Build the bounded semantic context for a turn's automatic team-memory recall.
 *
 * MemoryService owns redaction and the hard character cap at the network
 * boundary. This pure helper adds stable project identity without leaking the
 * machine-local checkout path, and leaves command-led turns untouched so pi can
 * expand them before any injected context is considered.
 */
export const memoryRecallQuery = (
  input: MemoryRecallQueryInput
): string | undefined => {
  if (leadsWithCommand(input.operatorText)) return undefined
  const recentTurns = (input.recentTurns ?? [])
    .filter(({ text }) => text.trim().length > 0)
    .slice(-3)
  return [
    input.operatorText,
    ...(recentTurns.length === 0
      ? []
      : [
          "Recent visible conversation:",
          ...recentTurns.map(({ role, text }) => `${role}: ${text.trim()}`)
        ]),
    `Project: ${input.repo}`,
    `Branch: ${input.branch}`
  ].join("\n")
}
