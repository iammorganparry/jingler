/**
 * Read-only terminal tabs that mirror an agent's running command.
 *
 * The output comes from the tool card's live `ToolDelta` snapshots, so this works
 * for every harness that streams command output — no PTY, nothing in main.
 * Tabs live in memory only: a mirror of a finished command isn't worth restoring.
 */
import { useSyncExternalStore } from "react"
import type { ToolCall } from "@jingler/core"
import type { ConversationContext } from "./conversation-machine.js"

export interface AgentCommandTab {
  readonly id: string
  readonly chatId: string
  readonly toolId: string
  readonly title: string
  readonly done: boolean
}

const NO_TABS: ReadonlyArray<AgentCommandTab> = []
let tabsBySession: Readonly<Record<string, ReadonlyArray<AgentCommandTab>>> = {}
const listeners = new Set<() => void>()

const setTabs = (sessionId: string, update: (tabs: ReadonlyArray<AgentCommandTab>) => ReadonlyArray<AgentCommandTab>): void => {
  const { [sessionId]: current = NO_TABS, ...rest } = tabsBySession
  const next = update(current)
  tabsBySession = next.length > 0 ? { ...rest, [sessionId]: next } : rest
  for (const listener of listeners) listener()
}

export const isAgentCommandTab = (id: string): boolean => id.startsWith("agent:")

/** Open (or reuse) the mirror tab for one tool call; resolves its tab id. */
export const watchAgentCommand = (sessionId: string, chatId: string, toolId: string, command: string): string => {
  const id = `agent:${chatId}:${toolId}`
  if (!agentCommandTabs(sessionId).some((tab) => tab.id === id)) {
    const title = command.length > 28 ? `${command.slice(0, 27).trimEnd()}…` : command
    setTabs(sessionId, (tabs) => [...tabs, { id, chatId, toolId, title, done: false }])
  }
  return id
}

export const closeAgentCommand = (sessionId: string, id: string): void =>
  setTabs(sessionId, (tabs) => tabs.filter((tab) => tab.id !== id))

/** Drop a session's mirrors, or only one chat's, when its conversation is disposed. */
export const clearAgentCommands = (sessionId: string, chatId?: string): void => {
  if (agentCommandTabs(sessionId).length === 0) return
  setTabs(sessionId, (tabs) => (chatId === undefined ? NO_TABS : tabs.filter((tab) => tab.chatId !== chatId)))
}

export const markDone = (sessionId: string, id: string): void => {
  if (!agentCommandTabs(sessionId).some((tab) => tab.id === id && !tab.done)) return
  setTabs(sessionId, (tabs) => tabs.map((tab) => (tab.id === id ? { ...tab, done: true } : tab)))
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const agentCommandTabs = (sessionId: string): ReadonlyArray<AgentCommandTab> =>
  tabsBySession[sessionId] ?? NO_TABS

export const useAgentCommandTabs = (sessionId: string): ReadonlyArray<AgentCommandTab> =>
  useSyncExternalStore(subscribe, () => agentCommandTabs(sessionId), () => agentCommandTabs(sessionId))

/** The tool call in the main transcript or any sub-agent's, newest first. */
export const findToolCall = (
  context: Pick<ConversationContext, "messages" | "subagents">,
  toolId: string
): ToolCall | undefined => {
  const messages = [...context.messages, ...context.subagents.map((agent) => agent.message)]
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i]!.parts) {
      if (part._tag === "Tool" && part.tool.id === toolId) return part.tool
    }
  }
  return undefined
}

/**
 * What to write to move a mirror from `shown` to `next`: the appended tail, a
 * full redraw, or nothing.
 *
 * Only LIVE snapshots drive it. A settled card's output is the formatted tool
 * result (stdout then stderr, or just the error message) — not the stream the
 * operator watched — so once anything has been shown, settling must not
 * replace it. Missing output (compacted, trimmed history) never clears either.
 */
export const mirrorWrite = (
  shown: string,
  next: string | undefined,
  running: boolean
): { readonly reset: boolean; readonly data: string } | null => {
  if (next === undefined || (!running && shown !== "")) return null
  return next.startsWith(shown) ? { reset: false, data: next.slice(shown.length) } : { reset: true, data: next }
}
