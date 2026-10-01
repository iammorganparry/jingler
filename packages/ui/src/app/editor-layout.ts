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
  readonly active: string
}

export interface EditorSplit {
  readonly type: "split"
  readonly id: string
  readonly axis: SplitAxis
  readonly children: ReadonlyArray<EditorNode>
  readonly ratios: ReadonlyArray<number>
}

export type EditorNode = TabGroup | EditorSplit

export interface EditorLayout {
  readonly root: EditorNode | null
  readonly focusedGroupId: string | null
  readonly mainChatId?: string | null
}

export interface TabDrag {
  readonly surface: SessionSurface
  readonly from?: string
}

export const EDITOR_LAYOUT_STORAGE_PREFIX = "sb.editor-layout.v1:"
const CHAT_RATIO = 1 / 3
const CONTENT_RATIO = 2 / 3
const keyOf = sessionSurfaceKey
const newId = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`
const laneOf = (surface: SessionSurface): "chat" | "content" => surface.kind === "chat" ? "chat" : "content"
export const groupsOf = (node: EditorNode | null): ReadonlyArray<TabGroup> =>
  node === null ? [] : node.type === "group" ? [node] : node.children.flatMap(groupsOf)

export const focusedGroup = (layout: EditorLayout): TabGroup | null => {
  const groups = groupsOf(layout.root)
  return groups.find((group) => group.id === layout.focusedGroupId) ?? groups[0] ?? null
}

export const activeSurface = (group: TabGroup): SessionSurface =>
  group.tabs.find((tab) => keyOf(tab) === group.active) ?? group.tabs[0]!

const unique = (tabs: ReadonlyArray<SessionSurface>): ReadonlyArray<SessionSurface> =>
  tabs.filter((tab, index) => tabs.findIndex((other) => keyOf(other) === keyOf(tab)) === index)

const sameTabs = (left: ReadonlyArray<SessionSurface>, right: ReadonlyArray<SessionSurface>): boolean =>
  left.length === right.length && left.every((tab, index) => keyOf(tab) === keyOf(right[index]!))

const existingLaneGroup = (layout: EditorLayout, lane: "chat" | "content"): TabGroup | undefined =>
  groupsOf(layout.root).find((group) => group.tabs.some((tab) => laneOf(tab) === lane))

const laneActive = (
  layout: EditorLayout,
  lane: "chat" | "content",
  tabs: ReadonlyArray<SessionSurface>,
  preferred?: string
): string => {
  if (preferred && tabs.some((tab) => keyOf(tab) === preferred)) return preferred
  const focused = focusedGroup(layout)
  const candidates = [focused, ...groupsOf(layout.root)].filter((group): group is TabGroup => Boolean(group))
  for (const group of candidates) {
    const active = group.tabs.find((tab) => keyOf(tab) === group.active && laneOf(tab) === lane)
    if (active && tabs.some((tab) => keyOf(tab) === keyOf(active))) return keyOf(active)
  }
  return keyOf(tabs.at(-1)!)
}

const laneGroup = (
  layout: EditorLayout,
  lane: "chat" | "content",
  tabs: ReadonlyArray<SessionSurface>,
  preferredActive?: string,
  reservedId?: string
): TabGroup | null => {
  if (tabs.length === 0) return null
  const existing = existingLaneGroup(layout, lane)
  const id = existing && existing.id !== reservedId ? existing.id : newId(`group-${lane}`)
  const active = laneActive(layout, lane, tabs, preferredActive)
  if (existing && existing.id === id && existing.active === active && sameTabs(existing.tabs, tabs)) return existing
  return { type: "group", id, tabs, active }
}

const normalisedRatios = (layout: EditorLayout): readonly [number, number] => {
  if (layout.root?.type !== "split" || layout.root.axis !== "row" || layout.root.ratios.length !== 2) {
    return [CHAT_RATIO, CONTENT_RATIO]
  }
  const [chat, content] = layout.root.ratios
  if (!(chat && content && Number.isFinite(chat) && Number.isFinite(content))) return [CHAT_RATIO, CONTENT_RATIO]
  const total = chat + content
  return total > 0 ? [chat / total, content / total] : [CHAT_RATIO, CONTENT_RATIO]
}

const canonicalRoot = (
  layout: EditorLayout,
  chat: TabGroup | null,
  content: TabGroup | null,
  requestedRatios?: readonly [number, number]
): EditorNode | null => {
  if (!chat) return content
  if (!content) return chat
  const ratios = requestedRatios ?? normalisedRatios(layout)
  const existing = layout.root?.type === "split" && layout.root.axis === "row" && layout.root.children.length === 2
    ? layout.root
    : undefined
  const unchanged = existing?.children[0] === chat && existing.children[1] === content &&
    existing.ratios[0] === ratios[0] && existing.ratios[1] === ratios[1]
  return unchanged
    ? existing
    : { type: "split", id: existing?.id ?? newId("split"), axis: "row", children: [chat, content], ratios }
}

const focusedLaneOf = (layout: EditorLayout): "chat" | "content" | undefined => {
  const group = focusedGroup(layout)
  return group ? laneOf(activeSurface(group)) : undefined
}

const canonical = (
  layout: EditorLayout,
  tabs: ReadonlyArray<SessionSurface>,
  options: {
    readonly focus?: "chat" | "content"
    readonly chatActive?: string
    readonly contentActive?: string
    readonly ratios?: readonly [number, number]
  } = {}
): EditorLayout => {
  const distinct = unique(tabs)
  const chat = laneGroup(layout, "chat", distinct.filter((tab) => tab.kind === "chat"), options.chatActive)
  const content = laneGroup(layout, "content", distinct.filter((tab) => tab.kind !== "chat"), options.contentActive, chat?.id)
  const focusLane = options.focus ?? focusedLaneOf(layout)
  const focused = focusLane === "content" ? content ?? chat : chat ?? content
  const root = canonicalRoot(layout, chat, content, options.ratios)
  if (root === layout.root && focused?.id === layout.focusedGroupId) return layout
  return { ...layout, root, focusedGroupId: focused?.id ?? null }
}

export const createEditorLayout = (tabs: ReadonlyArray<SessionSurface>, mainChatId?: string | null): EditorLayout =>
  canonical(
    { root: null, focusedGroupId: null, ...(mainChatId !== undefined ? { mainChatId } : {}) },
    tabs,
    { focus: tabs.at(-1) ? laneOf(tabs.at(-1)!) : undefined }
  )

export const activateTab = (layout: EditorLayout, groupId: string, key: string): EditorLayout => {
  const group = groupsOf(layout.root).find((candidate) => candidate.id === groupId)
  const surface = group?.tabs.find((tab) => keyOf(tab) === key)
  if (!group || !surface) return layout
  if (group.active === key && layout.focusedGroupId === groupId) return layout
  return canonical(layout, allTabs(layout), {
    focus: laneOf(surface),
    ...(surface.kind === "chat" ? { chatActive: key } : { contentActive: key })
  })
}

export const focusEditorGroup = (layout: EditorLayout, groupId: string): EditorLayout =>
  layout.focusedGroupId === groupId || !groupsOf(layout.root).some((group) => group.id === groupId)
    ? layout
    : { ...layout, focusedGroupId: groupId }

export const focusAdjacentGroup = (layout: EditorLayout, direction: -1 | 1): EditorLayout => {
  const groups = groupsOf(layout.root)
  const index = groups.findIndex((group) => group.id === focusedGroup(layout)?.id)
  const next = groups[index + direction]
  return next ? { ...layout, focusedGroupId: next.id } : layout
}

export const openTab = (layout: EditorLayout, surface: SessionSurface, mainChatId = layout.mainChatId): EditorLayout => {
  const key = keyOf(surface)
  const holder = groupsOf(layout.root).find((group) => group.tabs.some((tab) => keyOf(tab) === key))
  const reopened = surface.kind === "chat" && surface.id === mainChatId && layout.mainChatId !== mainChatId
    ? { ...layout, mainChatId }
    : layout
  if (holder) return activateTab(reopened, holder.id, key)
  return canonical(reopened, [...allTabs(reopened), surface], {
    focus: laneOf(surface),
    ...(surface.kind === "chat" ? { chatActive: key } : { contentActive: key })
  })
}

export const dropTab = (
  layout: EditorLayout,
  { surface }: TabDrag,
  _targetGroupId: string | null,
  _edge: DropEdge,
  _copy = false,
  mainChatId = layout.mainChatId
): EditorLayout => openTab(layout, surface, mainChatId)

const nextActiveAfterClose = (group: TabGroup, surface: SessionSurface): string | undefined => {
  const closedKey = keyOf(surface)
  if (group.active !== closedKey) return group.active
  const index = group.tabs.findIndex((tab) => keyOf(tab) === closedKey)
  const remaining = group.tabs.filter((tab) => keyOf(tab) !== closedKey)
  return remaining[Math.min(index, remaining.length - 1)] ? keyOf(remaining[Math.min(index, remaining.length - 1)]!) : undefined
}

const releaseMain = (layout: EditorLayout, surface: SessionSurface): EditorLayout =>
  surface.kind === "chat" && surface.id === layout.mainChatId && !allTabs(layout).some((tab) => keyOf(tab) === keyOf(surface))
    ? { ...layout, mainChatId: null }
    : layout

export const closeTab = (layout: EditorLayout, groupId: string, surface: SessionSurface): EditorLayout => {
  const group = groupsOf(layout.root).find((candidate) => candidate.id === groupId)
  if (!group?.tabs.some((tab) => keyOf(tab) === keyOf(surface))) return layout
  const nextActive = nextActiveAfterClose(group, surface)
  const next = canonical(layout, allTabs(layout).filter((tab) => keyOf(tab) !== keyOf(surface)), {
    ...(surface.kind === "chat" ? { chatActive: nextActive } : { contentActive: nextActive })
  })
  return releaseMain(next, surface)
}

export const closeSurfaceEverywhere = (layout: EditorLayout, surface: SessionSurface): EditorLayout => {
  const holder = groupsOf(layout.root).find((group) => group.tabs.some((tab) => keyOf(tab) === keyOf(surface)))
  return holder ? closeTab(layout, holder.id, surface) : layout
}

export const closeTabsWhere = (layout: EditorLayout, match: (surface: SessionSurface) => boolean): EditorLayout =>
  allTabs(layout).filter(match).reduce(closeSurfaceEverywhere, layout)

export const allTabs = (layout: EditorLayout): ReadonlyArray<SessionSurface> =>
  unique(groupsOf(layout.root).flatMap((group) => group.tabs))

export const moveActiveTab = (layout: EditorLayout, _direction: -1 | 1): EditorLayout => layout

export const applyEditorCommand = (layout: EditorLayout, command: string): EditorLayout => {
  if (command === "focus-left") return focusAdjacentGroup(layout, -1)
  if (command === "focus-right") return focusAdjacentGroup(layout, 1)
  const index = /^focus-(\d+)$/.exec(command)?.[1]
  const target = index === undefined ? undefined : groupsOf(layout.root)[Number(index)]
  return target ? focusEditorGroup(layout, target.id) : layout
}

export const resizedPair = (a: number, b: number, delta: number): readonly [number, number] | null => {
  const total = a + b
  if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(delta) && total > 0)) return null
  const minimum = Math.min(MIN_RATIO, total / 2)
  const next = Math.min(Math.max(a + delta, minimum), total - minimum)
  return [next, total - next]
}

export const resizeSplit = (layout: EditorLayout, splitId: string, index: number, delta: number): EditorLayout => {
  if (layout.root?.type !== "split" || layout.root.id !== splitId || index !== 0) return layout
  const pair = resizedPair(layout.root.ratios[0]!, layout.root.ratios[1]!, delta)
  if (!pair || (pair[0] === layout.root.ratios[0] && pair[1] === layout.root.ratios[1])) return layout
  return { ...layout, root: { ...layout.root, ratios: pair } }
}

export const pruneEditorLayout = (layout: EditorLayout, allowed: ReadonlySet<string>): EditorLayout => {
  const tabs = allTabs(layout).filter((tab) => allowed.has(keyOf(tab)))
  return tabs.length === allTabs(layout).length ? layout : canonical(layout, tabs)
}

const normalise = (ratios: ReadonlyArray<number>): ReadonlyArray<number> => {
  const total = ratios.reduce((sum, ratio) => sum + ratio, 0)
  return total > 0 && ratios.every((ratio) => Number.isFinite(ratio) && ratio > 0)
    ? ratios.map((ratio) => ratio / total)
    : ratios.map(() => 1 / ratios.length)
}

const parseGroup = (node: Record<string, unknown>): TabGroup => {
  const tabs = (Array.isArray(node.tabs) ? node.tabs : []).filter(isSurface)
  return {
    type: "group",
    id: typeof node.id === "string" && node.id ? node.id : newId("group"),
    tabs: unique(tabs),
    active: typeof node.active === "string" ? node.active : ""
  }
}

function parseNode(value: unknown): EditorNode | null {
  if (typeof value !== "object" || value === null) return null
  const node = value as Record<string, unknown>
  if (node.type === "group") return parseGroup(node)
  if (node.type !== "split" || (node.axis !== "row" && node.axis !== "column") || !Array.isArray(node.children)) return null
  const children = node.children.flatMap((child) => {
    const parsed = parseNode(child)
    return parsed ? [parsed] : []
  })
  const ratios = Array.isArray(node.ratios) ? node.ratios : []
  return {
    type: "split",
    id: typeof node.id === "string" && node.id ? node.id : newId("split"),
    axis: node.axis,
    children,
    ratios: normalise(children.map((_, index) => typeof ratios[index] === "number" ? ratios[index] : Number.NaN))
  }
}

const parsedLayout = (raw: unknown): EditorLayout | null => {
  if (typeof raw !== "object" || raw === null) return null
  const stored = raw as { root?: unknown; focusedGroupId?: unknown; mainChatId?: unknown }
  const root = stored.root === null ? null : parseNode(stored.root)
  if (root === null && stored.root !== null) return null
  const layout: EditorLayout = {
    root,
    focusedGroupId: typeof stored.focusedGroupId === "string" ? stored.focusedGroupId : null,
    ...(stored.mainChatId === null || typeof stored.mainChatId === "string" ? { mainChatId: stored.mainChatId } : {})
  }
  return canonical(layout, allTabs(layout))
}

const migratedLayout = (raw: unknown): EditorLayout | null => {
  if (typeof raw !== "object" || raw === null) return null
  const stored = raw as { panes?: unknown; focused?: unknown; openViews?: unknown; mainChatId?: unknown }
  if (!Array.isArray(stored.panes)) return null
  const panes = stored.panes.flatMap((pane: { surface?: unknown; ratio?: unknown }) => isSurface(pane?.surface) ? [pane] : [])
  const tabs = unique([
    ...panes.map((pane) => pane.surface as SessionSurface),
    ...(Array.isArray(stored.openViews) ? stored.openViews.filter(isSurface) : [])
  ])
  const focused = panes[typeof stored.focused === "number" ? stored.focused : 0]?.surface as SessionSurface | undefined
  const base: EditorLayout = {
    root: null,
    focusedGroupId: null,
    ...(stored.mainChatId === null || typeof stored.mainChatId === "string" ? { mainChatId: stored.mainChatId } : {})
  }
  return canonical(base, tabs, { focus: focused ? laneOf(focused) : undefined })
}

const readJson = (key: string): unknown => {
  const raw = localStorage.getItem(key)
  return raw === null ? undefined : JSON.parse(raw)
}

export const loadEditorLayout = (sessionId: string, fallback: SessionSurface, mainChatId?: string): EditorLayout => {
  const main: SessionSurface | null = mainChatId ? { kind: "chat", id: mainChatId } : null
  const initial = createEditorLayout(main ? unique([main, fallback]) : [fallback], mainChatId)
  try {
    const stored = readJson(`${EDITOR_LAYOUT_STORAGE_PREFIX}${sessionId}`)
    const restored = stored !== undefined
      ? parsedLayout(stored)
      : migratedLayout(readJson(`${SESSION_SURFACE_STORAGE_PREFIX}${sessionId}`))
    if (!restored) return initial
    if (restored.mainChatId === null || !main) return restored
    const withMain = { ...restored, mainChatId }
    return allTabs(withMain).some((tab) => keyOf(tab) === keyOf(main))
      ? withMain
      : canonical(withMain, [main, ...allTabs(withMain)])
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
