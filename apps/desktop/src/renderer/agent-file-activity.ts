import { useSyncExternalStore } from "react"
import type { AgentFileActivity } from "@jingler/core"

export interface PublishedAgentFileActivity extends AgentFileActivity {
  /** Increments for every observable phase/path event, including repeat paths. */
  readonly sequence: number
}

const activities = new Map<string, PublishedAgentFileActivity>()
const listeners = new Set<() => void>()
let sequence = 0

const keyOf = (sessionId: string, chatId: string): string => `${sessionId}\u0000${chatId}`

export const subscribeAgentFileActivity = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const notify = (): void => {
  for (const listener of listeners) listener()
}

export const getAgentFileActivity = (
  sessionId: string,
  chatId: string
): PublishedAgentFileActivity | null => activities.get(keyOf(sessionId, chatId)) ?? null

export const publishAgentFileActivity = (
  sessionId: string,
  chatId: string,
  activity: AgentFileActivity | null
): void => {
  const key = keyOf(sessionId, chatId)
  const previous = activities.get(key)
  if (activity === null) {
    if (previous === undefined) return
    activities.delete(key)
    notify()
    return
  }
  if (
    previous?.eventId === activity.eventId &&
    previous.path === activity.path &&
    previous.phase === activity.phase
  ) {
    return
  }
  sequence += 1
  activities.set(key, { ...activity, sequence })
  notify()
}

export const clearAgentFileActivityChat = (sessionId: string, chatId: string): void => {
  publishAgentFileActivity(sessionId, chatId, null)
}

export const clearAgentFileActivitySession = (sessionId: string): void => {
  const prefix = `${sessionId}\u0000`
  let changed = false
  for (const key of activities.keys()) {
    if (!key.startsWith(prefix)) continue
    activities.delete(key)
    changed = true
  }
  if (changed) notify()
}

export const useAgentFileActivity = (
  sessionId: string,
  chatId: string
): PublishedAgentFileActivity | null =>
  useSyncExternalStore(
    subscribeAgentFileActivity,
    () => getAgentFileActivity(sessionId, chatId),
    () => getAgentFileActivity(sessionId, chatId)
  )

const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//
const LINE_SUFFIX = /:\d+(?::\d+)?$/

/** Convert a tool target to a contained, repository-relative path. */
export const normalizeAgentFileTarget = (
  rawTarget: string,
  worktreeRoot: string | null | undefined
): string | null => {
  const raw = rawTarget.trim().replaceAll("\\", "/").replace(LINE_SUFFIX, "")
  if (raw === "" || raw.includes("\0")) return null
  const root = worktreeRoot?.trim().replaceAll("\\", "/").replace(/\/+$/, "")
  let relative = raw
  const absolute = raw.startsWith("/") || WINDOWS_ABSOLUTE.test(raw)
  if (absolute) {
    if (!root) return null
    const windows = WINDOWS_ABSOLUTE.test(root)
    const candidateForCompare = windows ? raw.toLocaleLowerCase() : raw
    const rootForCompare = windows ? root.toLocaleLowerCase() : root
    if (!candidateForCompare.startsWith(`${rootForCompare}/`)) return null
    relative = raw.slice(root.length + 1)
  }

  const parts: string[] = []
  for (const part of relative.replace(/^\.\//, "").split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.length === 0 ? null : parts.join("/")
}
