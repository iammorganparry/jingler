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
