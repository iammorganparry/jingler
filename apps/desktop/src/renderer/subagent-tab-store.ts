import { useSyncExternalStore } from "react"
import { createActor, type ActorRefFrom } from "xstate"
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
import { subagentViewMachine } from "./subagent-view-machine.js"

export interface SubagentTabSnapshot {
  readonly chatId: string
  readonly active: ReadonlyArray<SubagentFleetNode>
  readonly completed: ReadonlyArray<SubagentFleetNode>
  /** Live workflow roots: the orchestrators the chip popover nests agents under. */
  readonly orchestrators?: ReadonlyArray<SubagentFleetNode>
  readonly selectedId: string
}

const actorSnapshots = new Map<string, Map<string, SubagentTabSnapshot>>()
const controllerSnapshots = new Map<string, Map<string, SubagentTabSnapshot>>()
const controllerMounts = new Map<string, Map<string, number>>()
const sessionSnapshots = new Map<string, ReadonlyArray<SubagentTabSnapshot>>()
// Immutable mirror of `sessionSnapshots` so one hook can subscribe to every session.
let allSessionSnapshots: Readonly<Record<string, ReadonlyArray<SubagentTabSnapshot>>> = {}
// One in-place subagent view actor per chat lane, keyed by chatId.
const viewActors = new Map<string, ActorRefFrom<typeof subagentViewMachine>>()
const mainViewReaders = new Map<string, () => { draft: string; scrollTop: number }>()
// Immutable chatId → open subagent id mirror, so one hook can subscribe to every lane.
let viewSelectedIds: Readonly<Record<string, string>> = {}
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
  const snapshots = [...chatIds].map((chatId) => controllers.get(chatId) ?? actors.get(chatId)!)
  sessionSnapshots.set(sessionId, snapshots)
  allSessionSnapshots = { ...allSessionSnapshots, [sessionId]: snapshots }
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

/** Workflow roots that still have a live agent under them; a root with only settled steps is not shown. */
export const activeOrchestratorNodes = (
  nodes: ReadonlyArray<SubagentFleetNode>
): ReadonlyArray<SubagentFleetNode> => nodes.filter((root) =>
  root.nodeKind === "workflow" &&
  nodes.some((node) =>
    node.parentId === root.id && node.nodeKind === "agent" && ACTIVE.has(node.status)
  )
)

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
    orchestrators: activeOrchestratorNodes(nodes),
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

export const subagentViewActor = (chatId: string) => {
  let actor = viewActors.get(chatId)
  if (actor === undefined) {
    actor = createActor(subagentViewMachine, { input: { chatId } })
    actor.subscribe((snapshot) => {
      const id = snapshot.context.selectedId
      if ((viewSelectedIds[chatId] ?? null) === id) return
      const { [chatId]: _previous, ...rest } = viewSelectedIds
      viewSelectedIds = id === null ? rest : { ...rest, [chatId]: id }
      publish()
    })
    actor.start()
    viewActors.set(chatId, actor)
  }
  return actor
}

/** The mounted main transcript lets the swap capture its draft and scroll before it unmounts. */
export const registerMainViewReader = (
  chatId: string,
  read: () => { draft: string; scrollTop: number }
): (() => void) => {
  mainViewReaders.set(chatId, read)
  return () => {
    if (mainViewReaders.get(chatId) === read) mainViewReaders.delete(chatId)
  }
}

/** The child shown in a lane, from any tab snapshot of that chat. */
export const viewedChild = (
  snapshots: ReadonlyArray<SubagentTabSnapshot>,
  chatId: string,
  nodeId: string | null | undefined
): SubagentFleetNode | null => {
  if (nodeId == null) return null
  const snapshot = snapshots.find((candidate) => candidate.chatId === chatId)
  return [...(snapshot?.active ?? []), ...(snapshot?.completed ?? [])].find((n) => n.id === nodeId) ?? null
}

/** Content scope for entering a child: its subagent id when it owns a worktree, else the aggregate (shared checkout has no per-file data). */
export const scopeForChild = (chatId: string, nodeId: string): string => {
  const node = viewedChild(Object.values(allSessionSnapshots).flat(), chatId, nodeId)
  return node?.workspace ? node.subagentId : "all"
}

/** Every entry point (chip, View, transcript row, ⌘K, sidebar) swaps the chat lane through here. */
export const selectSubagentTab = (
  _sessionId: string,
  chatId: string,
  nodeId: string
): void => {
  const actor = subagentViewActor(chatId)
  if (nodeId === MAIN_FLEET_AGENT) {
    actor.send({ type: "BACK" })
    return
  }
  if (actor.getSnapshot().value === "main") {
    const view = mainViewReaders.get(chatId)?.()
    if (view) actor.send({ type: "SAVE_MAIN_VIEW", draft: view.draft, scrollTop: view.scrollTop })
  }
  actor.send({ type: "OPEN_SUBAGENT", id: nodeId, scope: scopeForChild(chatId, nodeId) })
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

export const useAllSessionSubagentTabs = (): Readonly<
  Record<string, ReadonlyArray<SubagentTabSnapshot>>
> =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => allSessionSnapshots,
    () => allSessionSnapshots
  )

export const useSubagentViewSelections = (): Readonly<Record<string, string>> =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => viewSelectedIds,
    () => viewSelectedIds
  )

export const clearSubagentTabs = (sessionId: string): void => {
  const chatIds = new Set([
    ...(actorSnapshots.get(sessionId)?.keys() ?? []),
    ...(controllerSnapshots.get(sessionId)?.keys() ?? [])
  ])
  for (const chatId of chatIds) {
    viewActors.get(chatId)?.stop()
    viewActors.delete(chatId)
    const { [chatId]: _removedView, ...rest } = viewSelectedIds
    viewSelectedIds = rest
  }
  actorSnapshots.delete(sessionId)
  controllerSnapshots.delete(sessionId)
  controllerMounts.delete(sessionId)
  sessionSnapshots.delete(sessionId)
  const { [sessionId]: _removed, ...rest } = allSessionSnapshots
  allSessionSnapshots = rest
  publish()
}

/** The child currently swapped into the session's active chat lane, or null on the main view. */
export const useViewedChild = (sessionId: string, chatId: string): SubagentFleetNode | null => {
  const selectedId = useSubagentViewSelections()[chatId]
  return viewedChild(useSessionSubagentTabs(sessionId), chatId, selectedId)
}
