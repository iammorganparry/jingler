import { useEffect, useEffectEvent, useMemo } from "react"
import {
  normalizeAgentFileTarget,
  useAgentFileActivity,
  type PublishedAgentFileActivity
} from "./agent-file-activity.js"

export interface FollowedAgentFile {
  readonly path: string
  readonly eventId: string
  readonly preview: string | null
  readonly completed: boolean
}

/** The contained, worktree-relative file an activity edits, or null when it has none. */
export const followedAgentFile = (
  activity: PublishedAgentFileActivity | null,
  worktreePath: string | undefined
): FollowedAgentFile | null => {
  if (activity === null) return null
  const path = normalizeAgentFileTarget(activity.path, worktreePath)
  if (path === null) return null
  return {
    path,
    eventId: activity.eventId,
    preview: activity.preview,
    completed: activity.phase === "completed"
  }
}

/**
 * Session-level Follow: while `enabled`, hand every file the agent edits to
 * `onFollow` so the host can open it as a file tab. Edits are read only through
 * `useAgentFileActivity`, so a Fleet agent being viewed overrides the main chat.
 */
export function useFollowAgentFiles({
  sessionId,
  chatId,
  worktreePath,
  enabled,
  onFollow
}: {
  readonly sessionId: string
  readonly chatId: string
  readonly worktreePath: string | undefined
  readonly enabled: boolean
  readonly onFollow: (file: FollowedAgentFile) => void
}): void {
  const activity = useAgentFileActivity(sessionId, chatId)
  const file = useMemo(() => followedAgentFile(activity, worktreePath), [activity, worktreePath])
  const follow = useEffectEvent(onFollow)
  useEffect(() => {
    if (enabled && file !== null) follow(file)
  }, [enabled, file])
}
