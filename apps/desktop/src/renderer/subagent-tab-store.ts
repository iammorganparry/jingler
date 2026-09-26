import { useSyncExternalStore } from "react"
import type {
  Subagent,
  SubagentFleetEvent,
  SubagentFleetNode
} from "@jingler/core"
import { isSubagentFleetNodeNewer } from "@jingler/cli-adapters/runtime/subagents/subagent-run-tree-reducer"
import {
  MAIN_FLEET_AGENT,
  parentRuntimeSessionIdFromFleetEvents,
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
const controllerMounts = new Map<string, Map<string, number>>()
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

export const recentSubagentNodes = (
  nodes: ReadonlyArray<SubagentFleetNode>
): ReadonlyArray<SubagentFleetNode> => [...nodes]
  .sort((left, right) =>
    (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt)
  )
  .slice(0, 8)

const retainNewestNode = (
  nodes: Map<string, SubagentFleetNode>,
  node: SubagentFleetNode
): void => {
  const current = nodes.get(node.id)
  if (current === undefined || !isSubagentFleetNodeNewer(current, node)) {
    nodes.set(node.id, node)
  }
}

export const completedSubagentNodes = (
  events: ReadonlyArray<SubagentFleetEvent>
): ReadonlyArray<SubagentFleetNode> => {
  const latest = new Map<string, SubagentFleetNode>()
  const terminal = new Map<string, SubagentFleetNode>()
  const removedAt = new Map<string, number>()
  for (const event of events) {
    if (event._tag === "Remove") {
      removedAt.set(event.id, Math.max(removedAt.get(event.id) ?? 0, event.registryRevision))
      continue
    }
    const nodes = event._tag === "Upsert"
      ? [event.node]
      : event._tag === "Snapshot"
        ? event.snapshot.nodes
        : []
    for (const node of nodes) {
      retainNewestNode(latest, node)
      if (node.nodeKind === "agent" && COMPLETED.has(node.status)) {
        retainNewestNode(terminal, node)
      }
    }
  }
  const values = [...terminal.values()].filter((node) => {
    const current = latest.get(node.id)
    return current === undefined ||
      (removedAt.get(node.id) ?? -1) >= current.registryRevision ||
      COMPLETED.has(current.status)
  })
  const childOrchestrations = new Set(
    values
      .filter((node) => node.runId !== node.orchestrationRunId)
      .map((node) => node.orchestrationRunId)
  )
  return recentSubagentNodes(values.filter((node) =>
    node.runId !== node.orchestrationRunId ||
    !childOrchestrations.has(node.orchestrationRunId)
  ))
}

export const projectSubagentTabs = (input: {
  readonly sessionId: string
  readonly chatId: string
  readonly continuation: string | null
  readonly events: ReadonlyArray<SubagentFleetEvent>
  readonly legacyAgents: ReadonlyArray<Subagent>
  readonly canonicalNodes?: ReadonlyArray<SubagentFleetNode>
}): SubagentTabSnapshot => {
  const parentRuntimeSessionId = parentRuntimeSessionIdFromFleetEvents(
    input.events,
    input.continuation ?? `${input.sessionId}:${input.chatId}`
  )
  const legacyEvents = projectLegacySubagents(parentRuntimeSessionId, input.legacyAgents)
  const events = [...input.events, ...legacyEvents]
  const nodes = input.canonicalNodes === undefined
    ? projectSubagentFleetEvents(parentRuntimeSessionId, events).nodes
    : [
        ...input.canonicalNodes,
        ...projectSubagentFleetEvents(parentRuntimeSessionId, legacyEvents).nodes
      ]
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

export const retainSubagentTabController = (
  sessionId: string,
  chatId: string
): void => {
  const chats = new Map(controllerMounts.get(sessionId) ?? [])
  chats.set(chatId, (chats.get(chatId) ?? 0) + 1)
  controllerMounts.set(sessionId, chats)
}

export const releaseSubagentTabController = (
  sessionId: string,
  chatId: string
): void => {
  const mounts = new Map(controllerMounts.get(sessionId) ?? [])
  const remaining = (mounts.get(chatId) ?? 1) - 1
  if (remaining > 0) {
    mounts.set(chatId, remaining)
    controllerMounts.set(sessionId, mounts)
    return
  }
  mounts.delete(chatId)
  if (mounts.size === 0) controllerMounts.delete(sessionId)
  else controllerMounts.set(sessionId, mounts)

  const snapshots = new Map(controllerSnapshots.get(sessionId) ?? [])
  snapshots.delete(chatId)
  if (snapshots.size === 0) controllerSnapshots.delete(sessionId)
  else controllerSnapshots.set(sessionId, snapshots)
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
  controllerMounts.delete(sessionId)
  sessionSnapshots.delete(sessionId)
  selections.delete(sessionId)
  publish()
}
