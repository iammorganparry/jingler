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
  const unique = tabs.filter((t, i) => tabs.findIndex((o) => keyOf(o) === keyOf(t)) === i)
  const root = unique.length > 0 ? groupOf(unique) : null
  return { root, focusedGroupId: root?.id ?? null, ...(mainChatId !== undefined ? { mainChatId } : {}) }
}

export const activateTab = (layout: EditorLayout, groupId: string, key: string): EditorLayout =>
  layout.root
    ? commit(
        layout,
        mapGroups(layout.root, (g) => (g.id === groupId && g.active !== key && g.tabs.some((t) => keyOf(t) === key) ? { ...g, active: key } : g)),
        groupId
      )
    : layout

export const focusEditorGroup = (layout: EditorLayout, groupId: string): EditorLayout =>
  groupsOf(layout.root).some((g) => g.id === groupId) ? { ...layout, focusedGroupId: groupId } : layout

/** Moves focus through groups in reading order; stops at the ends. */
export const focusAdjacentGroup = (layout: EditorLayout, direction: -1 | 1): EditorLayout => {
  const groups = groupsOf(layout.root)
  const index = groups.findIndex((g) => g.id === focusedGroup(layout)?.id)
  const next = groups[index + direction]
  return next ? { ...layout, focusedGroupId: next.id } : layout
}

/**
 * Shows a surface: reveals it where it is already open (the focused group
 * first), otherwise adds it as a tab to the focused group.
 */
export const openTab = (
  layout: EditorLayout,
  surface: SessionSurface,
  mainChatId = layout.mainChatId
): EditorLayout => {
  layout = reopenMain(layout, surface, mainChatId)
  const key = keyOf(surface)
  const focused = focusedGroup(layout)
  const holder = focused?.tabs.some((t) => keyOf(t) === key)
    ? focused
    : groupsOf(layout.root).find((g) => g.tabs.some((t) => keyOf(t) === key))
  if (holder) return activateTab(layout, holder.id, key)
  if (!(layout.root && focused)) return commit(layout, groupOf([surface]))
  return commit(layout, mapGroups(layout.root, (g) => (g.id === focused.id ? addTab(g, surface) : g)), focused.id)
}

const splitBeside = (node: EditorNode, targetId: string, edge: Exclude<DropEdge, "center">, added: TabGroup): EditorNode => {
  if (node.type === "split") return mapChildren(node, (c) => splitBeside(c, targetId, edge, added))
  if (node.id !== targetId) return node
  const axis: SplitAxis = edge === "left" || edge === "right" ? "row" : "column"
  const before = edge === "left" || edge === "top"
  return { type: "split", id: newId("split"), axis, children: before ? [added, node] : [node, added], ratios: [0.5, 0.5] }
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
  copy = false
): EditorLayout => {
  const target = groupsOf(layout.root).find((g) => g.id === targetGroupId)
  if (!(layout.root && target)) return openTab(layout, surface)
  const key = keyOf(surface)
  const move = from !== undefined && !copy
  if (move && from === target.id && (edge === "center" || target.tabs.length === 1)) {
    return activateTab(layout, target.id, key)
  }
  const added = edge === "center" ? null : groupOf([surface])
  let root = added
    ? splitBeside(layout.root, target.id, edge as Exclude<DropEdge, "center">, added)
    : mapGroups(layout.root, (g) => (g.id === target.id ? addTab(g, surface) : g))
  if (move) root = mapGroups(root, (g) => (g.id === from ? withoutTab(g, key) : g))
  return commit(layout, root, added?.id ?? target.id)
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

/** Drags the divider between `children[index]` and `children[index + 1]` of a split. */
export const resizeSplit = (layout: EditorLayout, splitId: string, index: number, delta: number): EditorLayout => {
  if (!(layout.root && Number.isFinite(delta))) return layout
  const resize = (node: EditorNode): EditorNode => {
    if (node.type === "group") return node
    if (node.id !== splitId) return mapChildren(node, resize)
    const a = node.ratios[index]
    const b = node.ratios[index + 1]
    if (a === undefined || b === undefined || a + b < MIN_RATIO * 2) return node
    const next = Math.min(Math.max(a + delta, MIN_RATIO), a + b - MIN_RATIO)
    return { ...node, ratios: node.ratios.map((r, i) => (i === index ? next : i === index + 1 ? a + b - next : r)) }
  }
  return { ...layout, root: resize(layout.root) }
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
    tabs: tabs.filter((t, i) => tabs.findIndex((o) => keyOf(o) === keyOf(t)) === i),
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

/** The flat v1 surface list becomes one row of one-tab groups. */
const migrateSurfaceLayout = (raw: unknown): EditorLayout | null => {
  if (typeof raw !== "object" || raw === null) return null
  const old = raw as { panes?: unknown; focused?: unknown; openViews?: unknown; mainChatId?: unknown }
  if (!Array.isArray(old.panes)) return null
  const panes = old.panes.flatMap((p: { surface?: unknown; ratio?: unknown }) =>
    isSurface(p?.surface) ? [{ surface: p.surface, ratio: typeof p.ratio === "number" ? p.ratio : Number.NaN }] : []
  )
  const groups = panes.map((p) => groupOf([p.surface]))
  const focused = groups[typeof old.focused === "number" ? old.focused : 0] ?? groups[0]
  // Views that were open beside the panes stay open as background tabs.
  const views = (Array.isArray(old.openViews) ? old.openViews : []).filter(isSurface)
  const withViews = groups.map((g) =>
    g === focused ? { ...g, tabs: [...g.tabs, ...views.filter((v) => !g.tabs.some((t) => keyOf(t) === keyOf(v)))] } : g
  )
  const root: EditorNode | null =
    withViews.length > 1
      ? { type: "split", id: newId("split"), axis: "row", children: withViews, ratios: normalise(panes.map((p) => p.ratio)) }
      : (withViews[0] ?? null)
  const mainChatId = old.mainChatId === null ? null : typeof old.mainChatId === "string" ? old.mainChatId : undefined
  return commit({ root: null, focusedGroupId: null, ...(mainChatId !== undefined ? { mainChatId } : {}) }, root, focused?.id)
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

/**
 * Restores a session's layout, migrating the v1 surface list on first read.
 * A live main chat that is missing (and was not explicitly closed) is put back
 * at the front of the first group.
 */
export const loadEditorLayout = (sessionId: string, fallback: SessionSurface, mainChatId?: string): EditorLayout => {
  const main: SessionSurface | null = mainChatId ? { kind: "chat", id: mainChatId } : null
  const initial = createEditorLayout(main ? [main, fallback] : [fallback], mainChatId)
  try {
    const stored = readJson(`${EDITOR_LAYOUT_STORAGE_PREFIX}${sessionId}`)
    const layout =
      stored !== undefined
        ? parseLayout(stored)
        : migrateSurfaceLayout(readJson(`${SESSION_SURFACE_STORAGE_PREFIX}${sessionId}`))
    if (!layout) return initial
    if (layout.mainChatId === null || !main) return layout
    const withMain = { ...layout, mainChatId }
    const present = groupsOf(layout.root).some((g) => g.tabs.some((t) => keyOf(t) === keyOf(main)))
    if (present) return withMain
    const first = groupsOf(layout.root)[0]
    if (!(layout.root && first)) return initial
    return commit(withMain, mapGroups(layout.root, (g) => (g.id === first.id ? { ...g, tabs: [main, ...g.tabs] } : g)))
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
