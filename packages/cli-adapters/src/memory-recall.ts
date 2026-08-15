import { leadsWithCommand } from "./turn-prompt.js"

export interface MemoryRecallQueryInput {
  readonly operatorText: string
  readonly repo: string
  readonly branch: string
}

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
  return [
    input.operatorText,
    `Project: ${input.repo}`,
    `Branch: ${input.branch}`
  ].join("\n")
}
