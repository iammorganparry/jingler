import { HEADER_VIEWS_MAX } from "@jingler/core"

/** Toggle a view's pinned state. Refuses to pin past `HEADER_VIEWS_MAX`. */
export const toggleHeaderView = (
  pinned: ReadonlyArray<string>,
  id: string
): ReadonlyArray<string> => {
  const isPinned = pinned.includes(id)
  if (isPinned) return pinned.filter((candidate) => candidate !== id)
  if (pinned.length >= HEADER_VIEWS_MAX) return pinned
  return [...pinned, id]
}

/** Move a pinned view one slot up or down. A no-op at either end of the list. */
export const moveHeaderView = (
  pinned: ReadonlyArray<string>,
  id: string,
  direction: "up" | "down"
): ReadonlyArray<string> => {
  const index = pinned.indexOf(id)
  if (index === -1) return pinned
  const target = direction === "up" ? index - 1 : index + 1
  if (target < 0 || target >= pinned.length) return pinned
  const next = [...pinned]
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}
