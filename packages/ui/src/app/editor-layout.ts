/**
 * A session's editor layout: a split tree whose leaves are TAB GROUPS.
 *
 * Every chat, file and view is a tab (`SessionSurface`). A split nests in both
 * directions (`row` = side by side, `column` = stacked). Each session owns one
 * layout; sessions themselves never split.
 *
 * Pure and React-free so every rule here is cheap to test. `tidy` is the one
 * place that keeps the tree canonical: empty groups disappear, a split left with
 * one child is replaced by that child, and a split inside a same-axis parent is
 * flattened into it (its share of the parent's slot is kept).
 */
import {
  isSurface,
  SESSION_SURFACE_STORAGE_PREFIX,
  sessionSurfaceKey,
  type SessionSurface
} from "./session-surface-layout.js"
import { MIN_RATIO } from "./split-layout.js"

export type SplitAxis = "row" | "column"
export type DropEdge = "left" | "right" | "top" | "bottom" | "center"

export interface TabGroup {
  readonly type: "group"
  readonly id: string
  readonly tabs: ReadonlyArray<SessionSurface>
  /** `sessionSurfaceKey` of the tab on screen. Always one of `tabs`. */
  readonly active: string
}

export interface EditorSplit {
  readonly type: "split"
  readonly id: string
  readonly axis: SplitAxis
  readonly children: ReadonlyArray<EditorNode>
  /** One share per child, summing to 1. */
  readonly ratios: ReadonlyArray<number>
}

export type EditorNode = TabGroup | EditorSplit

export interface EditorLayout {
  /** `null` when every tab is closed. */
  readonly root: EditorNode | null
  readonly focusedGroupId: string | null
  /** Null records an explicit close, so restoring the layout must not reopen main. */
  readonly mainChatId?: string | null
}

/** What a tab drag carries. `from` is absent when dragging from the sidebar. */
export interface TabDrag {
  readonly surface: SessionSurface
  readonly from?: string
}

export const EDITOR_LAYOUT_STORAGE_PREFIX = "sb.editor-layout.v1:"

const newId = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`
const keyOf = sessionSurfaceKey

/** Chat lane pixel constraints (see chat-lane-machine.ts) */
export const CHAT_LANE_MIN_PX = 360
export const CHAT_LANE_MAX_PX = 560
export const CHAT_LANE_COLLAPSE_PX = 320
const CHAT_LANE_SNAP_RATIOS = [1 / 3, 1 / 2] as const
const CHAT_LANE_SNAP_TOLERANCE_PX = 16

/** Keep content readable when several groups are open. */
export const MAX_GROUPS = 3
/** Narrowest a group may be and still show content — below this it shows only its tab strip. */
export const MIN_GROUP_PX = 240

const CHAT_RATIO = 1 / 3
const CONTENT_RATIO = 2 / 3

/**
 * Compute the initial chat lane ratio, clamped to 360-560px.
 * Falls back to 1/3 when containerWidth is unknown (0 or negative).
 */
export const chatLaneRatio = (containerWidth: number): number => {
  if (containerWidth <= 0) return 1 / 3
  const idealPx = containerWidth / 3
  const clampedPx = Math.min(CHAT_LANE_MAX_PX, Math.max(CHAT_LANE_MIN_PX, idealPx))
  return clampedPx / containerWidth
}

/**
 * Apply pixel-based resize to the chat lane: snap to 1/3 or 1/2, clamp to 360-560px,
 * collapse (return null) below 320px.
 */
export const resizeChatLane = (
  currentRatio: number,
  delta: number,
  containerWidth: number
): number | null => {
  if (containerWidth <= 0) return currentRatio + delta
  const currentPx = currentRatio * containerWidth
  const newPx = currentPx + delta * containerWidth

  // Collapse below threshold
  if (newPx < CHAT_LANE_COLLAPSE_PX) return null

  // Snap to 1/3 or 1/2 if within tolerance
  for (const snapRatio of CHAT_LANE_SNAP_RATIOS) {
    const snapPx = snapRatio * containerWidth
    if (Math.abs(newPx - snapPx) <= CHAT_LANE_SNAP_TOLERANCE_PX) {
      return snapRatio
    }
  }

  // Clamp to 360-560px
  const clampedPx = Math.min(CHAT_LANE_MAX_PX, Math.max(CHAT_LANE_MIN_PX, newPx))
  return clampedPx / containerWidth
}

const laneOf = (surface: SessionSurface): "chat" | "content" => surface.kind === "chat" ? "chat" : "content"
const isBrowser = (surface: SessionSurface) => surface.kind === "view" && surface.id === "browser"
const uniqueTabs = (tabs: ReadonlyArray<SessionSurface>): ReadonlyArray<SessionSurface> => {
  const seen = new Set<string>()
  return tabs.filter((tab) => {
    const key = keyOf(tab)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
const isMain = (layout: EditorLayout, surface: SessionSurface) =>
  surface.kind === "chat" && surface.id === layout.mainChatId

export const groupsOf = (node: EditorNode | null): ReadonlyArray<TabGroup> =>
  node === null ? [] : node.type === "group" ? [node] : node.children.flatMap(groupsOf)

export const focusedGroup = (layout: EditorLayout): TabGroup | null => {
  const groups = groupsOf(layout.root)
  return groups.find((g) => g.id === layout.focusedGroupId) ?? groups[0] ?? null
}

export const activeSurface = (group: TabGroup): SessionSurface =>
  group.tabs.find((t) => keyOf(t) === group.active) ?? group.tabs[0]!

/**
 * Structural sharing: a split is only re-created when one of its children
 * changed. Untouched groups and splits keep their identity, so memoised group
 * components skip re-rendering when another group changes.
 */
const mapChildren = (node: EditorSplit, fn: (child: EditorNode) => EditorNode): EditorSplit => {
  let changed = false
  const children = node.children.map((child) => {
    const next = fn(child)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...node, children } : node
}

const mapGroups = (node: EditorNode, fn: (group: TabGroup) => TabGroup): EditorNode =>
  node.type === "group" ? fn(node) : mapChildren(node, (c) => mapGroups(c, fn))

const normalise = (ratios: ReadonlyArray<number>): ReadonlyArray<number> => {
  const valid = ratios.every((r) => Number.isFinite(r) && r > 0)
  const total = ratios.reduce((sum, r) => sum + r, 0)
  return valid && total > 0 ? ratios.map((r) => r / total) : ratios.map(() => 1 / ratios.length)
}

const tidy = (node: EditorNode): EditorNode | null => {
  if (node.type === "group") {
    if (node.tabs.length === 0) return null
    return node.tabs.some((t) => keyOf(t) === node.active) ? node : { ...node, active: keyOf(node.tabs[0]!) }
  }
  const children: EditorNode[] = []
  const ratios: number[] = []
  let changed = false
  node.children.forEach((child, index) => {
    const kept = tidy(child)
    if (kept !== child) changed = true
    if (!kept) return
    const share = node.ratios[index] ?? 1 / node.children.length
    if (kept.type === "split" && kept.axis === node.axis) {
      changed = true
      kept.children.forEach((c, j) => {
        children.push(c)
        ratios.push(share * (kept.ratios[j] ?? 0))
      })
    } else {
      children.push(kept)
      ratios.push(share)
    }
  })
  if (children.length <= 1) return children[0] ?? null
  return changed ? { ...node, children, ratios: normalise(ratios) } : node
}

/** Every mutation ends here: tidy the tree and keep focus on a group that exists. */
const commit = (layout: EditorLayout, root: EditorNode | null, focus = layout.focusedGroupId): EditorLayout => {
  const tidied = root && tidy(root)
  const groups = groupsOf(tidied)
  const focusedGroupId = groups.find((g) => g.id === focus)?.id ?? groups[0]?.id ?? null
  return { ...layout, root: tidied, focusedGroupId }
}

const groupOf = (tabs: ReadonlyArray<SessionSurface>, active = tabs.at(-1)!): TabGroup => ({
  type: "group",
  id: newId("group"),
  tabs,
  active: keyOf(active)
})

const addTab = (group: TabGroup, surface: SessionSurface): TabGroup => {
  const key = keyOf(surface)
  if (group.active === key) return group
  return group.tabs.some((t) => keyOf(t) === key)
    ? { ...group, active: key }
    : { ...group, tabs: [...group.tabs, surface], active: key }
}

const withoutTab = (group: TabGroup, key: string): TabGroup => {
  const index = group.tabs.findIndex((t) => keyOf(t) === key)
  if (index === -1) return group
  const tabs = group.tabs.filter((_, i) => i !== index)
  // Closing the active tab shows its right-hand neighbour, like VS Code.
  const active = group.active === key ? keyOf(tabs[Math.min(index, tabs.length - 1)] ?? group.tabs[0]!) : group.active
  return { ...group, tabs, active }
}

/** Closing the protected main chat everywhere records it as explicitly closed. */
const releaseMain = (layout: EditorLayout, surface: SessionSurface): EditorLayout =>
  isMain(layout, surface) && !groupsOf(layout.root).some((g) => g.tabs.some((t) => keyOf(t) === keyOf(surface)))
    ? { ...layout, mainChatId: null }
    : layout

const reopenMain = (layout: EditorLayout, surface: SessionSurface, mainChatId: string | null | undefined) =>
  surface.kind === "chat" && surface.id === mainChatId && layout.mainChatId !== mainChatId
    ? { ...layout, mainChatId }
    : layout

export const createEditorLayout = (
  tabs: ReadonlyArray<SessionSurface>,
  mainChatId?: string | null
): EditorLayout => {
  const unique = uniqueTabs(tabs)
  const chats = unique.filter((tab) => laneOf(tab) === "chat")
  const content = unique.filter((tab) => laneOf(tab) === "content")
  const chatGroup = chats.length > 0 ? groupOf(chats) : null
  const contentGroup = content.length > 0 ? groupOf(content) : null
  const root: EditorNode | null = chatGroup && contentGroup
    ? {
        type: "split",
        id: newId("split"),
        axis: "row",
        children: [chatGroup, contentGroup],
        ratios: [CHAT_RATIO, CONTENT_RATIO]
      }
    : chatGroup ?? contentGroup
  return {
    root,
    focusedGroupId: contentGroup?.id ?? chatGroup?.id ?? null,
    ...(mainChatId !== undefined ? { mainChatId } : {})
  }
}

export const activateTab = (layout: EditorLayout, groupId: string, key: string): EditorLayout => {
  if (!layout.root) return layout
  const group = groupsOf(layout.root).find((candidate) => candidate.id === groupId)
  if (!group?.tabs.some((tab) => keyOf(tab) === key)) return layout
  if (group.active === key) return focusEditorGroup(layout, groupId)
  return commit(
    layout,
    mapGroups(layout.root, (candidate) => candidate.id === groupId ? { ...candidate, active: key } : candidate),
    groupId
  )
}

export const focusEditorGroup = (layout: EditorLayout, groupId: string): EditorLayout =>
  layout.focusedGroupId === groupId || !groupsOf(layout.root).some((group) => group.id === groupId)
    ? layout
    : { ...layout, focusedGroupId: groupId }

/** Moves focus through groups in reading order; stops at the ends. */
export const focusAdjacentGroup = (layout: EditorLayout, direction: -1 | 1): EditorLayout => {
  const groups = groupsOf(layout.root)
  const index = groups.findIndex((g) => g.id === focusedGroup(layout)?.id)
  const next = groups[index + direction]
  return next ? { ...layout, focusedGroupId: next.id } : layout
}

/** Count content groups in a row split. */
const contentGroupCount = (node: EditorNode | null): number => {
  if (!node) return 0
  if (node.type === "group") return node.tabs.some((tab) => laneOf(tab) === "content") ? 1 : 0
  if (node.axis !== "row") return 0
  return node.children.reduce((sum, child) => sum + contentGroupCount(child), 0)
}

/**
 * Shows a surface: reveals it where it is already open, otherwise adds it to
 * the focused matching lane (or the first matching lane).
 */
export const openTab = (
  layout: EditorLayout,
  surface: SessionSurface,
  mainChatId = layout.mainChatId
): EditorLayout => {
  layout = reopenMain(layout, surface, mainChatId)
  const key = keyOf(surface)
  const groups = groupsOf(layout.root)
  const focused = focusedGroup(layout)
  const holder = focused?.tabs.some((tab) => keyOf(tab) === key)
    ? focused
    : groups.find((group) => group.tabs.some((tab) => keyOf(tab) === key))
  if (holder) return activateTab(layout, holder.id, key)
  if (!layout.root) return commit(layout, groupOf([surface]))
  const lane = laneOf(surface)
  const target = focused?.tabs.some((tab) => laneOf(tab) === lane)
    ? focused
    : groups.find((group) => group.tabs.some((tab) => laneOf(tab) === lane))
  if (target) {
    return commit(
      layout,
      mapGroups(layout.root, (group) => group.id === target.id ? addTab(group, surface) : group),
      target.id
    )
  }
  const anchor = focused ?? groups[0]
  if (!anchor) return commit(layout, groupOf([surface]))
  const added = groupOf([surface])
  const edge = lane === "chat" ? "left" : "right"
  if (lane === "content" && contentGroupCount(layout.root) >= MAX_GROUPS) return layout
  return commit(
    layout,
    splitBeside(layout.root, anchor.id, edge, added, [CHAT_RATIO, CONTENT_RATIO]),
    added.id
  )
}

const splitBeside = (
  node: EditorNode,
  targetId: string,
  edge: Exclude<DropEdge, "center">,
  added: TabGroup,
  ratios: readonly [number, number] = [0.5, 0.5]
): EditorNode => {
  if (node.type === "split") return mapChildren(node, (child) => splitBeside(child, targetId, edge, added, ratios))
  if (node.id !== targetId) return node
  const axis: SplitAxis = edge === "left" || edge === "right" ? "row" : "column"
  const before = edge === "left" || edge === "top"
  return { type: "split", id: newId("split"), axis, children: before ? [added, node] : [node, added], ratios }
}

const dropActivationTarget = (
  groups: ReadonlyArray<TabGroup>,
  surface: SessionSurface,
  move: boolean,
  from: string | undefined,
  target: TabGroup,
  edge: DropEdge
): TabGroup | undefined => {
  const holder = groups.find((group) => group.tabs.some((tab) => keyOf(tab) === keyOf(surface)))
  // Browser bodies all control one native WebContentsView per session/chat, so
  // they cannot be copied into competing groups.
  if (isBrowser(surface) && holder && !move) return holder
  return move && from === target.id && (edge === "center" || target.tabs.length === 1)
    ? target
    : undefined
}

/**
 * A drop on a group: the middle adds the tab there, an edge splits beside it.
 * A tab dragged out of a group MOVES unless `copy` (⌥ held); a sidebar drag
 * has no source and always adds.
 */
export const dropTab = (
  layout: EditorLayout,
  { surface, from }: TabDrag,
  targetGroupId: string | null,
  edge: DropEdge,
  copy = false,
  mainChatId = layout.mainChatId
): EditorLayout => {
  layout = reopenMain(layout, surface, mainChatId)
  const groups = groupsOf(layout.root)
  const target = groups.find((group) => group.id === targetGroupId)
  if (!(layout.root && target)) return openTab(layout, surface)
  const dropTarget = edge === "center" && !target.tabs.some((tab) => laneOf(tab) === laneOf(surface))
    ? groups.find((group) => group.tabs.some((tab) => laneOf(tab) === laneOf(surface))) ?? target
    : target
  const key = keyOf(surface)
  const move = from !== undefined && !copy
  const activationTarget = dropActivationTarget(groups, surface, move, from, dropTarget, edge)
  if (activationTarget) return activateTab(layout, activationTarget.id, key)
  if (edge !== "center" && laneOf(surface) === "content" && contentGroupCount(layout.root) >= MAX_GROUPS) return layout
  const added = edge === "center" ? null : groupOf([surface])
  let root = added
    ? splitBeside(layout.root, dropTarget.id, edge as Exclude<DropEdge, "center">, added)
    : mapGroups(layout.root, (group) => group.id === dropTarget.id ? addTab(group, surface) : group)
  if (move) root = mapGroups(root, (group) => group.id === from ? withoutTab(group, key) : group)
  return commit(layout, root, added?.id ?? dropTarget.id)
}

/** Closes one tab in one group. */
export const closeTab = (layout: EditorLayout, groupId: string, surface: SessionSurface): EditorLayout =>
  layout.root
    ? releaseMain(
        commit(layout, mapGroups(layout.root, (g) => (g.id === groupId ? withoutTab(g, keyOf(surface)) : g))),
        surface
      )
    : layout

/** Closes a surface in every group — the sidebar's close button. */
export const closeSurfaceEverywhere = (layout: EditorLayout, surface: SessionSurface): EditorLayout =>
  layout.root
    ? releaseMain(commit(layout, mapGroups(layout.root, (g) => withoutTab(g, keyOf(surface)))), surface)
    : layout

/** Closes every tab matching `match` in every group. */
export const closeTabsWhere = (layout: EditorLayout, match: (surface: SessionSurface) => boolean): EditorLayout =>
  allTabs(layout).filter(match).reduce(closeSurfaceEverywhere, layout)

/** Every distinct open surface, in reading order. */
export const allTabs = (layout: EditorLayout): ReadonlyArray<SessionSurface> =>
  uniqueTabs(groupsOf(layout.root).flatMap((group) => group.tabs))

/**
 * Applies a keyboard command (other than close, which has side effects) to the
 * focused group. Unknown commands return the layout unchanged.
 */
export const applyEditorCommand = (layout: EditorLayout, command: string): EditorLayout => {
  if (command === "focus-left") return focusAdjacentGroup(layout, -1)
  if (command === "focus-right") return focusAdjacentGroup(layout, 1)
  const index = /^focus-(\d+)$/.exec(command)?.[1]
  const target = index === undefined ? undefined : groupsOf(layout.root)[Number(index)]
  return target ? focusEditorGroup(layout, target.id) : layout
}

export const moveActiveTab = (layout: EditorLayout, _direction: -1 | 1): EditorLayout => layout

/** Drags the divider between `children[index]` and `children[index + 1]` of a split. */
/** Clamp a divider move to the largest minimum the adjacent pair can afford. */
export const resizedPair = (a: number, b: number, delta: number): readonly [number, number] | null => {
  const total = a + b
  if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(delta) && total > 0)) return null
  const minimum = Math.min(MIN_RATIO, total / 2)
  const next = Math.min(Math.max(a + delta, minimum), total - minimum)
  return [next, total - next]
}

/**
 * Detect if a split is the chat/content lane split: a 2-child row split where
 * the left is all chats and the right is all content.
 */
const isChatContentSplit = (node: EditorNode): boolean => {
  if (node.type !== "split" || node.axis !== "row" || node.children.length !== 2) return false
  const left = node.children[0]
  const right = node.children[1]
  if (!left || !right) return false
  const leftGroups = groupsOf(left)
  const rightGroups = groupsOf(right)
  if (leftGroups.length === 0 || rightGroups.length === 0) return false
  const leftAllChat = leftGroups.every((g) => g.tabs.every((t) => laneOf(t) === "chat"))
  const rightAllContent = rightGroups.every((g) => g.tabs.every((t) => laneOf(t) === "content"))
  return leftAllChat && rightAllContent
}

/** True when this drag would take the root chat lane below the collapse threshold. */
export const wouldCollapseChatLane = (layout: EditorLayout, splitId: string, index: number, delta: number, containerWidth: number | undefined): boolean => {
  const root = layout.root
  if (!root || root.type !== "split" || root.id !== splitId || index !== 0 || !containerWidth || !isChatContentSplit(root)) return false
  return resizeChatLane(root.ratios[0] ?? 0, delta, containerWidth) === null
}

/** The layout with the chat lane hidden (collapsed to the Ask pill); ratios are untouched so restore keeps the width. */
export const withoutChatLane = (layout: EditorLayout): EditorLayout => {
  const root = layout.root
  if (!root || root.type !== "split" || !isChatContentSplit(root)) return layout
  const content = root.children[1]
  return content ? { ...layout, root: content } : layout
}

/** Just the chat lane of a chat/content split (what the narrow-window drawer shows), or null when the layout has no such split. */
export const chatLaneOnly = (layout: EditorLayout): EditorLayout | null => {
  const root = layout.root
  if (!root || root.type !== "split" || !isChatContentSplit(root)) return null
  const chat = root.children[0]
  return chat ? { ...layout, root: chat } : null
}

/** Apply chat lane resize or generic pair resize based on split type. */
const applyResize = (
  node: EditorSplit,
  index: number,
  delta: number,
  containerWidth: number | undefined
): EditorSplit | null => {
  const a = node.ratios[index]
  const b = node.ratios[index + 1]
  if (a === undefined || b === undefined) return null

  // Apply chat lane pixel logic to the chat/content split
  if (index === 0 && isChatContentSplit(node) && containerWidth !== undefined && containerWidth > 0) {
    // The pane collapses to the Ask pill first (wouldCollapseChatLane); this pin only covers callers without that.
    const nextChatRatio = resizeChatLane(a, delta, containerWidth) ?? CHAT_LANE_MIN_PX / containerWidth
    return { ...node, ratios: [nextChatRatio, 1 - nextChatRatio] }
  }

  // Generic split resizing
  const pair = resizedPair(a, b, delta)
  if (!pair || (pair[0] === a && pair[1] === b)) return null
  return { ...node, ratios: node.ratios.map((r, i) => (i === index ? pair[0] : i === index + 1 ? pair[1] : r)) }
}

/**
 * Resize a split, applying pixel-based logic to the chat/content lane split.
 * Pass containerWidth for pixel-aware chat lane resizing; omit for generic ratio resizing.
 */
export const resizeSplit = (
  layout: EditorLayout,
  splitId: string,
  index: number,
  delta: number,
  containerWidth?: number
): EditorLayout => {
  if (!layout.root) return layout
  const resize = (node: EditorNode): EditorNode => {
    if (node.type === "group") return node
    if (node.id !== splitId) return mapChildren(node, resize)
    const resized = applyResize(node, index, delta, containerWidth)
    return resized ?? node
  }
  const root = resize(layout.root)
  return root === layout.root ? layout : { ...layout, root }
}

/** Drops tabs whose chat, file or view no longer exists (by `sessionSurfaceKey`). */
export const pruneEditorLayout = (layout: EditorLayout, allowed: ReadonlySet<string>): EditorLayout => {
  if (!layout.root) return layout
  const root = mapGroups(layout.root, (g) =>
    g.tabs.every((t) => allowed.has(keyOf(t))) ? g : { ...g, tabs: g.tabs.filter((t) => allowed.has(keyOf(t))) }
  )
  return root === layout.root ? layout : commit(layout, root)
}

const storedId = (value: unknown, prefix: string): string =>
  typeof value === "string" && value ? value : newId(prefix)

const parseGroup = (node: Record<string, unknown>): TabGroup => {
  const tabs = (Array.isArray(node.tabs) ? node.tabs : []).filter(isSurface)
  return {
    type: "group",
    id: storedId(node.id, "group"),
    tabs: uniqueTabs(tabs),
    active: typeof node.active === "string" ? node.active : ""
  }
}

const parseSplit = (node: Record<string, unknown>, axis: SplitAxis, children: ReadonlyArray<unknown>): EditorSplit => {
  const ratios = Array.isArray(node.ratios) ? node.ratios : []
  const pairs = children.flatMap((c, i) => {
    const child = parseNode(c)
    const ratio = ratios[i]
    return child ? [{ child, ratio: typeof ratio === "number" ? ratio : Number.NaN }] : []
  })
  return {
    type: "split",
    id: storedId(node.id, "split"),
    axis,
    children: pairs.map((p) => p.child),
    ratios: normalise(pairs.map((p) => p.ratio))
  }
}

function parseNode(value: unknown): EditorNode | null {
  if (typeof value !== "object" || value === null) return null
  const node = value as Record<string, unknown>
  if (node.type === "group") return parseGroup(node)
  if (node.type === "split" && (node.axis === "row" || node.axis === "column") && Array.isArray(node.children)) {
    return parseSplit(node, node.axis, node.children)
  }
  return null
}

/** The flat v1 surface list becomes the default chat/content lanes. */
const migrateSurfaceLayout = (raw: unknown): EditorLayout | null => {
  if (typeof raw !== "object" || raw === null) return null
  const old = raw as { panes?: unknown; focused?: unknown; openViews?: unknown; mainChatId?: unknown }
  if (!Array.isArray(old.panes)) return null
  const surfaces = old.panes.flatMap((pane: { surface?: unknown }) =>
    isSurface(pane?.surface) ? [pane.surface] : []
  )
  const views = (Array.isArray(old.openViews) ? old.openViews : []).filter(isSurface)
  const mainChatId = old.mainChatId === null
    ? null
    : typeof old.mainChatId === "string"
      ? old.mainChatId
      : undefined
  const layout = createEditorLayout([...surfaces, ...views], mainChatId)
  const focused = surfaces[typeof old.focused === "number" ? old.focused : 0]
  const holder = focused && groupsOf(layout.root).find((group) =>
    group.tabs.some((tab) => keyOf(tab) === keyOf(focused))
  )
  return holder && focused ? activateTab(layout, holder.id, keyOf(focused)) : layout
}

const parseLayout = (raw: unknown): EditorLayout | null => {
  if (typeof raw !== "object" || raw === null) return null
  const stored = raw as { root?: unknown; focusedGroupId?: unknown; mainChatId?: unknown }
  const root = stored.root === null ? null : parseNode(stored.root)
  if (root === null && stored.root !== null) return null
  const mainChatId = stored.mainChatId === null ? null : typeof stored.mainChatId === "string" ? stored.mainChatId : undefined
  return commit(
    { root: null, focusedGroupId: null, ...(mainChatId !== undefined ? { mainChatId } : {}) },
    root,
    typeof stored.focusedGroupId === "string" ? stored.focusedGroupId : null
  )
}

const readJson = (key: string): unknown => {
  const raw = localStorage.getItem(key)
  return raw === null ? undefined : JSON.parse(raw)
}


/** Filter out deprecated "files" view tabs from a restored layout. */
const migrateFilesTab = (layout: EditorLayout): EditorLayout => {
  const isFilesTab = (surface: SessionSurface) =>
    surface.kind === "view" && surface.id === "files"
  return closeTabsWhere(layout, isFilesTab)
}

/** The Pull Request view became Checks; a persisted `pr` view tab reopens as Checks. */
const migratePrTab = (layout: EditorLayout): EditorLayout => {
  const isPr = (surface: SessionSurface) => surface.kind === "view" && surface.id === "pr"
  if (!layout.root) return layout
  const root = mapGroups(layout.root, (group) => {
    if (!group.tabs.some(isPr)) return group
    const tabs = uniqueTabs(group.tabs.map((tab): SessionSurface => (isPr(tab) ? { kind: "view", id: "checks" } : tab)))
    return { ...group, tabs, active: group.active === keyOf({ kind: "view", id: "pr" }) ? keyOf({ kind: "view", id: "checks" }) : group.active }
  })
  return commit(layout, root)
}

/**
 * Restores a session's layout, migrating the v1 surface list on first read.
 * A live main chat that is missing (and was not explicitly closed) is restored
 * to the chat lane.
 */
export const loadEditorLayout = (sessionId: string, fallback: SessionSurface, mainChatId?: string): EditorLayout => {
  const main: SessionSurface | null = mainChatId ? { kind: "chat", id: mainChatId } : null
  const initial = createEditorLayout(main ? [main, fallback] : [fallback], mainChatId)
  try {
    const stored = readJson(`${EDITOR_LAYOUT_STORAGE_PREFIX}${sessionId}`)
    let layout =
      stored !== undefined
        ? parseLayout(stored)
        : migrateSurfaceLayout(readJson(`${SESSION_SURFACE_STORAGE_PREFIX}${sessionId}`))
    if (!layout) return initial
    layout = migratePrTab(migrateFilesTab(layout))
    if (layout.mainChatId === null || !main) return layout
    const withMain = { ...layout, mainChatId }
    const present = groupsOf(layout.root).some((group) =>
      group.tabs.some((tab) => keyOf(tab) === keyOf(main))
    )
    if (present) return withMain
    const restored = openTab(withMain, main, mainChatId)
    return layout.focusedGroupId
      ? focusEditorGroup(restored, layout.focusedGroupId)
      : restored
  } catch {
    return initial
  }
}

export const saveEditorLayout = (sessionId: string, layout: EditorLayout): void => {
  try {
    localStorage.setItem(`${EDITOR_LAYOUT_STORAGE_PREFIX}${sessionId}`, JSON.stringify(layout))
  } catch {
    // The live layout still works when storage is unavailable.
  }
}

export const removeEditorLayout = (sessionId: string): void => {
  try {
    localStorage.removeItem(`${EDITOR_LAYOUT_STORAGE_PREFIX}${sessionId}`)
    localStorage.removeItem(`${SESSION_SURFACE_STORAGE_PREFIX}${sessionId}`)
  } catch {
    // Storage cleanup is best-effort.
  }
}
