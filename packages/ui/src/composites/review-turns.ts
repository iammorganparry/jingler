import type { Message } from "@jingler/core"

/** One agent turn and the files its tools actually changed. */
export interface ReviewTurn {
  readonly id: string
  readonly label: string
  readonly paths: readonly string[]
}

/** Turns that changed files, numbered by position among all assistant turns. */
export const reviewTurnsOf = (messages: readonly Message[]): readonly ReviewTurn[] => {
  let number = 0
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return []
    number += 1
    const paths = new Set<string>()
    for (const part of message.parts) {
      if (part._tag !== "Tool") continue
      for (const change of part.tool.fileChanges?.changes ?? []) paths.add(change.path)
    }
    return paths.size === 0 ? [] : [{ id: message.id, label: `Turn ${number}`, paths: [...paths] }]
  })
}

/** Keep only the items a turn touched; no turn keeps everything. */
export const narrowToTurn = <T extends { readonly path: string }>(
  items: readonly T[],
  turn: ReviewTurn | null
): readonly T[] => {
  if (turn === null) return items
  const paths = new Set(turn.paths)
  return items.filter((item) => paths.has(item.path))
}

/** One file change an agent tool made to a single path, labelled with the turn it came from. */
export interface AgentEdit {
  readonly id: string
  /** The assistant message the edit belongs to. */
  readonly turnId: string
  /** `Agent edit · Turn 3` — numbered like `reviewTurnsOf`. */
  readonly label: string
  readonly preview: string | null
}

/** True when this turn already reported the same previewed change; records it otherwise. */
const repeated = (seen: Set<string>, turnId: string, preview: string | null | undefined): boolean => {
  if (preview == null) return false
  const key = `${turnId}\0${preview}`
  if (seen.has(key)) return true
  seen.add(key)
  return false
}

/** Every change the agent's tools made to `path`, oldest first. */
export const agentEditsOf = (messages: readonly Message[], path: string): readonly AgentEdit[] => {
  let number = 0
  // A turn can report the same change twice (e.g. a write and its follow-up diff); count it once.
  const seen = new Set<string>()
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return []
    number += 1
    return message.parts.flatMap((part) =>
      part._tag !== "Tool"
        ? []
        : (part.tool.fileChanges?.changes ?? []).flatMap((change, index) => {
            if (change.path !== path) return []
            if (repeated(seen, message.id, change.preview)) return []
            return [{ id: `${part.tool.id}:${index}`, turnId: message.id, label: `Agent edit · Turn ${number}`, preview: change.preview }]
          })
    )
  })
}
