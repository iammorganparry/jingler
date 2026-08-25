import { activityLabel, type AgentRosterEntry, type Session } from "@jingler/core"
import { useSyncExternalStore } from "react"
import {
  getAgentFileActivityVersion,
  getAgentTouchedFiles,
  subscribeAgentFileActivity
} from "./agent-file-activity.js"
import { useChatActivities } from "./conversation-registry.js"
import { usePlanSessions } from "./plan-presence.js"

export const projectAgentRoster = (
  session: Session,
  activities: ReturnType<typeof useChatActivities>,
  planChats: ReadonlySet<string>
): ReadonlyArray<AgentRosterEntry> =>
  session.chats.map((chat) => {
    const activity = activities[chat.id]
    return {
      chatId: chat.id,
      title: chat.title ?? "Untitled agent",
      status:
        activity?.kind === "needs-input" || activity?.kind === "needs-approval"
          ? "needs-input"
          : activity === undefined
            ? "idle"
            : "running",
      task: activity === undefined ? chat.title : activityLabel(activity),
      planStage: planChats.has(chat.id) ? "Plan active" : null,
      touchedFiles: [...getAgentTouchedFiles(session.id, chat.id)],
      updatedAt: chat.updatedAt
    }
  })

export const useAgentRoster = (session: Session): ReadonlyArray<AgentRosterEntry> => {
  const activities = useChatActivities(session.id)
  const planChats = usePlanSessions()
  useSyncExternalStore(
    subscribeAgentFileActivity,
    getAgentFileActivityVersion,
    getAgentFileActivityVersion
  )
  return projectAgentRoster(session, activities, planChats)
}
