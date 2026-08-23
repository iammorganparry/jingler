import { useSyncExternalStore } from "react"
import type {
  Subagent,
  SubagentFleetEvent,
  SubagentFleetNode
} from "@jingler/core"
import {
  MAIN_FLEET_AGENT,
  parentPiSessionIdFromFleetEvents,
  projectLegacySubagents,
  projectSubagentFleetEvents
} from "./subagent-fleet-machine.js"

export interface SubagentTabSnapshot {
  readonly chatId: string
  readonly active: ReadonlyArray<SubagentFleetNode>
  readonly completed: ReadonlyArray<SubagentFleetNode>
  readonly selectedId: string
}

interface SelectionRequest {
  readonly chatId: string
  readonly nodeId: string
  readonly nonce: number
}

const actorSnapshots = new Map<string, Map<string, SubagentTabSnapshot>>()
const controllerSnapshots = new Map<string, Map<string, SubagentTabSnapshot>>()
const sessionSnapshots = new Map<string, ReadonlyArray<SubagentTabSnapshot>>()
const selections = new Map<string, SelectionRequest>()
const listeners = new Set<() => void>()
const EMPTY: ReadonlyArray<SubagentTabSnapshot> = []
const ACTIVE = new Set(["queued", "running", "paused", "needs-attention"])
const COMPLETED = new Set(["completed", "failed", "stopped", "unknown"])

const publish = (): void => {
  for (const listener of listeners) listener()
}

const refreshSession = (sessionId: string): void => {
  const actors = actorSnapshots.get(sessionId) ?? new Map()
  const controllers = controllerSnapshots.get(sessionId) ?? new Map()
  const chatIds = new Set([...actors.keys(), ...controllers.keys()])
  sessionSnapshots.set(
    sessionId,
    [...chatIds].map((chatId) => controllers.get(chatId) ?? actors.get(chatId)!)
  )
  publish()
}

const setSnapshot = (
  target: Map<string, Map<string, SubagentTabSnapshot>>,
  sessionId: string,
  snapshot: SubagentTabSnapshot
): void => {
  const chats = new Map(target.get(sessionId) ?? [])
  chats.set(snapshot.chatId, snapshot)
  target.set(sessionId, chats)
  refreshSession(sessionId)
}

export const completedSubagentNodes = (
  events: ReadonlyArray<SubagentFleetEvent>
): ReadonlyArray<SubagentFleetNode> => {
  const completed = new Map<string, SubagentFleetNode>()
  for (const event of events) {
    if (event._tag !== "Upsert") continue
    const node = event.node
    if (node.nodeKind === "agent" && COMPLETED.has(node.status)) {
      completed.delete(node.id)
      completed.set(node.id, node)
    } else {
      completed.delete(node.id)
    }
  }
  const values = [...completed.values()]
  const childOrchestrations = new Set(
    values
      .filter((node) => node.runId !== node.orchestrationRunId)
      .map((node) => node.orchestrationRunId)
  )
  return values
    .filter((node) =>
      node.runId !== node.orchestrationRunId ||
      !childOrchestrations.has(node.orchestrationRunId)
    )
    .slice(-8)
    .reverse()
}

export const projectSubagentTabs = (input: {
  readonly sessionId: string
  readonly chatId: string
  readonly piSessionId: string | null
  readonly events: ReadonlyArray<SubagentFleetEvent>
  readonly legacyAgents: ReadonlyArray<Subagent>
}): SubagentTabSnapshot => {
  const parentPiSessionId = parentPiSessionIdFromFleetEvents(
    input.events,
    input.piSessionId ?? `${input.sessionId}:${input.chatId}`
  )
  const events = [
    ...input.events,
    ...projectLegacySubagents(parentPiSessionId, input.legacyAgents)
  ]
  const nodes = projectSubagentFleetEvents(parentPiSessionId, events).nodes
  return {
    chatId: input.chatId,
    active: nodes.filter((node) =>
      node.nodeKind === "agent" && ACTIVE.has(node.status)
    ),
    completed: completedSubagentNodes(events),
    selectedId: MAIN_FLEET_AGENT
  }
}

export const publishSubagentTabs = (
  sessionId: string,
  snapshot: SubagentTabSnapshot
): void => setSnapshot(controllerSnapshots, sessionId, snapshot)

export const publishActorSubagentTabs = (
  sessionId: string,
  snapshot: SubagentTabSnapshot
): void => setSnapshot(actorSnapshots, sessionId, snapshot)

export const releaseSubagentTabController = (
  sessionId: string,
  chatId: string
): void => {
  const chats = new Map(controllerSnapshots.get(sessionId) ?? [])
  chats.delete(chatId)
  if (chats.size === 0) controllerSnapshots.delete(sessionId)
  else controllerSnapshots.set(sessionId, chats)
  refreshSession(sessionId)
}

export const selectSubagentTab = (
  sessionId: string,
  chatId: string,
  nodeId: string
): void => {
  const previous = selections.get(sessionId)
  selections.set(sessionId, {
    chatId,
    nodeId,
    nonce: (previous?.nonce ?? 0) + 1
  })
  publish()
}

export const useSessionSubagentTabs = (
  sessionId: string
): ReadonlyArray<SubagentTabSnapshot> =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => sessionSnapshots.get(sessionId) ?? EMPTY,
    () => sessionSnapshots.get(sessionId) ?? EMPTY
  )

export const useSubagentTabSelection = (
  sessionId: string
): SelectionRequest | null =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => selections.get(sessionId) ?? null,
    () => selections.get(sessionId) ?? null
  )

export const clearSubagentTabs = (sessionId: string): void => {
  actorSnapshots.delete(sessionId)
  controllerSnapshots.delete(sessionId)
  sessionSnapshots.delete(sessionId)
  selections.delete(sessionId)
  publish()
}
