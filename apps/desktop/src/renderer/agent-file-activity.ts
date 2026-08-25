import { useSyncExternalStore } from "react"
import type { AgentFileActivity } from "@jingler/core"

export interface PublishedAgentFileActivity extends AgentFileActivity {
  /** Increments for every observable phase/path event, including repeat paths. */
  readonly sequence: number
}

const activities = new Map<string, PublishedAgentFileActivity>()
const touchedFiles = new Map<string, ReadonlyArray<string>>()
/**
 * Per-session override from the Fleet: when the operator selects a delegated
 * agent in the Fleet drawer, ITS file activity takes precedence over the main
 * chat's, so an enabled Follow tracks the selected agent's edits. Keyed by
 * session alone — Fleet selection is a session-level choice, not per chat.
 */
const fleetActivities = new Map<string, PublishedAgentFileActivity>()
const listeners = new Set<() => void>()
let sequence = 0

const keyOf = (sessionId: string, chatId: string): string => `${sessionId}\u0000${chatId}`

export const getAgentFileActivityVersion = (): number => sequence

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
    previous.phase === activity.phase &&
    previous.preview === activity.preview
  ) {
    return
  }
  sequence += 1
  activities.set(key, { ...activity, sequence })
  const paths = touchedFiles.get(key) ?? []
  if (!paths.includes(activity.path)) {
    touchedFiles.set(key, [...paths, activity.path].slice(-20))
  }
  notify()
}

export const clearAgentFileActivityChat = (sessionId: string, chatId: string): void => {
  touchedFiles.delete(keyOf(sessionId, chatId))
  publishAgentFileActivity(sessionId, chatId, null)
}

export const getAgentTouchedFiles = (
  sessionId: string,
  chatId: string
): ReadonlyArray<string> => touchedFiles.get(keyOf(sessionId, chatId)) ?? []

/**
 * Publish (or clear, with `null`) the SELECTED Fleet agent's file activity.
 *
 * While present it wins over the main chat's activity in
 * `useAgentFileActivity`, so the file browser's existing Follow controller —
 * rename resolution, sandboxed normalization, scroll-to-hunk — tracks the
 * delegated agent's edits without knowing the Fleet exists.
 */
export const publishFleetAgentFileActivity = (
  sessionId: string,
  activity: AgentFileActivity | null
): void => {
  const previous = fleetActivities.get(sessionId)
  if (activity === null) {
    if (previous === undefined) return
    fleetActivities.delete(sessionId)
    notify()
    return
  }
  if (
    previous?.eventId === activity.eventId &&
    previous.path === activity.path &&
    previous.phase === activity.phase &&
    previous.preview === activity.preview
  ) {
    return
  }
  sequence += 1
  fleetActivities.set(sessionId, { ...activity, sequence })
  notify()
}

export const getFleetAgentFileActivity = (
  sessionId: string
): PublishedAgentFileActivity | null => fleetActivities.get(sessionId) ?? null

export const clearAgentFileActivitySession = (sessionId: string): void => {
  const prefix = `${sessionId}\u0000`
  let changed = false
  for (const key of activities.keys()) {
    if (!key.startsWith(prefix)) continue
    activities.delete(key)
    touchedFiles.delete(key)
    changed = true
  }
  if (fleetActivities.delete(sessionId)) changed = true
  if (changed) notify()
}

export const useAgentFileActivity = (
  sessionId: string,
  chatId: string
): PublishedAgentFileActivity | null =>
  useSyncExternalStore(
    subscribeAgentFileActivity,
    () => getFleetAgentFileActivity(sessionId) ?? getAgentFileActivity(sessionId, chatId),
    () => getFleetAgentFileActivity(sessionId) ?? getAgentFileActivity(sessionId, chatId)
  )

const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//
const LINE_SUFFIX = /:\d+(?::\d+)?$/
const withoutMacPrivateAlias = (path: string): string =>
  path.startsWith("/private/") ? path.slice("/private".length) : path

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
    const canonicalRaw = windows ? raw : withoutMacPrivateAlias(raw)
    const canonicalRoot = windows ? root : withoutMacPrivateAlias(root)
    const candidateForCompare = windows ? canonicalRaw.toLowerCase() : canonicalRaw
    const rootForCompare = windows ? canonicalRoot.toLowerCase() : canonicalRoot
    if (!candidateForCompare.startsWith(`${rootForCompare}/`)) return null
    relative = canonicalRaw.slice(canonicalRoot.length + 1)
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
