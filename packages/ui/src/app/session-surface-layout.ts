import type { TabKey } from "./tab-contributions.js"
import { MAX_PANES, MIN_RATIO } from "./split-layout.js"

export type SessionSurface =
  | { readonly kind: "chat"; readonly id: string }
  | { readonly kind: "file"; readonly id: string }
  | { readonly kind: "view"; readonly id: TabKey; readonly chatId?: string }

export interface SessionSurfacePane {
  readonly surface: SessionSurface
  readonly ratio: number
}

export interface SessionSurfaceLayout {
  /** Null records an explicit close, so restoring the layout must not reopen main. */
  readonly mainChatId?: string | null
  readonly panes: ReadonlyArray<SessionSurfacePane>
  readonly focused: number
  readonly openViews: ReadonlyArray<Extract<SessionSurface, { kind: "view" }>>
}

export const SESSION_SURFACE_DND_MIME = "application/x-jingler-session-surface"
export const SESSION_SURFACE_COMMAND_EVENT = "jingler:session-surface-command"
export type SessionSurfaceCommand =
  | "close"
  | "move-left"
  | "move-right"
  | "focus-left"
  | "focus-right"
  | "focus-0"
  | "focus-1"
  | "focus-2"
  | "focus-3"
export const SESSION_SURFACE_MIN_PX = 220
export const maxSessionSurfacesForWidth = (width: number): number =>
  width <= 0 ? MAX_PANES : Math.max(1, Math.min(MAX_PANES, Math.floor(width / SESSION_SURFACE_MIN_PX)))
export const SESSION_SURFACE_STORAGE_PREFIX = "sb.session-surfaces.v1:"

export const sessionSurfaceKey = (surface: SessionSurface): string =>
  JSON.stringify([surface.kind, surface.id, surface.kind === "view" ? surface.chatId ?? null : null])

export const parseSessionSurfaceKey = (value: string): SessionSurface | null => {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 3) return null
    const [kind, id, chatId] = parsed
    if ((kind !== "chat" && kind !== "file" && kind !== "view") || typeof id !== "string") {
      return null
    }
    if (kind === "view") {
      return typeof chatId === "string" ? { kind, id, chatId } : chatId === null ? { kind, id } : null
    }
    return chatId === null ? { kind, id } : null
  } catch {
    return null
  }
}

export const sessionSurfaceLabel = (surface: SessionSurface): string =>
  surface.kind === "file" ? surface.id : surface.id

const sameSurface = (left: SessionSurface, right: SessionSurface): boolean =>
  sessionSurfaceKey(left) === sessionSurfaceKey(right)

const evenly = (surfaces: ReadonlyArray<SessionSurface>): ReadonlyArray<SessionSurfacePane> =>
  surfaces.map((surface) => ({ surface, ratio: 1 / surfaces.length }))

const normalise = (panes: ReadonlyArray<SessionSurfacePane>): ReadonlyArray<SessionSurfacePane> => {
  if (panes.length === 0) return panes
  const total = panes.reduce((sum, pane) => sum + pane.ratio, 0)
  return total > 0
    ? panes.map((pane) => ({ ...pane, ratio: pane.ratio / total }))
    : evenly(panes.map((pane) => pane.surface))
}

const clampFocus = (focused: number, length: number): number =>
  Math.min(Math.max(Number.isInteger(focused) ? focused : 0, 0), Math.max(0, length - 1))

export const createSessionSurfaceLayout = (surface: SessionSurface): SessionSurfaceLayout => ({
  panes: [{ surface, ratio: 1 }],
  focused: 0,
  openViews: []
})

export const focusSessionSurface = (
  layout: SessionSurfaceLayout,
  index: number
): SessionSurfaceLayout =>
  index < 0 || index >= layout.panes.length || index === layout.focused
    ? layout
    : { ...layout, focused: index }

export const selectSessionSurface = (
  layout: SessionSurfaceLayout,
  surface: SessionSurface
): SessionSurfaceLayout => {
  const visible = layout.panes.findIndex((pane) => sameSurface(pane.surface, surface))
  if (visible !== -1) return focusSessionSurface(layout, visible)
  if (layout.panes.length === 0) return { ...layout, panes: [{ surface, ratio: 1 }], focused: 0 }
  const focused = layout.panes[layout.focused]?.surface
  const replacingMain = focused?.kind === "chat" && focused.id === layout.mainChatId
  const target = replacingMain
    ? layout.panes.findIndex((pane) => pane.surface.kind !== "chat" || pane.surface.id !== layout.mainChatId)
    : layout.focused
  if (target === -1) return splitSessionSurface(layout, surface, layout.panes.length, MAX_PANES)
  return {
    ...layout,
    focused: target,
    panes: layout.panes.map((pane, index) => index === target ? { ...pane, surface } : pane)
  }
}

export const openSessionSurface = (
  layout: SessionSurfaceLayout,
  surface: SessionSurface,
  maxPanes: number
): SessionSurfaceLayout => {
  const visible = layout.panes.findIndex((pane) => sameSurface(pane.surface, surface))
  if (visible !== -1) return focusSessionSurface(layout, visible)
  return layout.panes.length < Math.min(MAX_PANES, maxPanes)
    ? splitSessionSurface(layout, surface, layout.panes.length, maxPanes)
    : selectSessionSurface(layout, surface)
}

export const openSessionView = (
  layout: SessionSurfaceLayout,
  surface: Extract<SessionSurface, { kind: "view" }>,
  maxPanes = 1
): SessionSurfaceLayout => {
  const openViews = layout.openViews.some((view) => sameSurface(view, surface))
    ? layout.openViews
    : [...layout.openViews, surface]
  return openSessionSurface({ ...layout, openViews }, surface, maxPanes)
}

export const splitSessionSurface = (
  layout: SessionSurfaceLayout,
  surface: SessionSurface,
  at: number,
  maxPanes: number
): SessionSurfaceLayout => {
  const existing = layout.panes.findIndex((pane) => sameSurface(pane.surface, surface))
  if (existing === -1 && (layout.panes.length >= MAX_PANES || layout.panes.length >= maxPanes)) return layout
  const surfaces = layout.panes.map((pane) => pane.surface)
  if (existing !== -1) surfaces.splice(existing, 1)
  const adjusted = existing !== -1 && existing < at ? at - 1 : at
  const index = Math.min(Math.max(Number.isInteger(adjusted) ? adjusted : surfaces.length, 0), surfaces.length)
  surfaces.splice(index, 0, surface)
  return { ...layout, panes: evenly(surfaces), focused: index }
}

export const replaceSessionSurface = (
  layout: SessionSurfaceLayout,
  index: number,
  surface: SessionSurface
): SessionSurfaceLayout => {
  if (index < 0 || index >= layout.panes.length) return layout
  if (sameSurface(layout.panes[index]!.surface, surface)) return focusSessionSurface(layout, index)
  const targetSurface = layout.panes[index]!.surface
  if (targetSurface.kind === "chat" && targetSurface.id === layout.mainChatId) {
    return selectSessionSurface({ ...layout, focused: index }, surface)
  }
  const duplicate = layout.panes.findIndex((pane) => sameSurface(pane.surface, surface))
  const kept = layout.panes.filter((_, paneIndex) => paneIndex === index || paneIndex !== duplicate)
  const target = duplicate !== -1 && duplicate < index ? index - 1 : index
  const panes = normalise(
    kept.map((pane, paneIndex) => (paneIndex === target ? { ...pane, surface } : pane))
  )
  return { ...layout, panes, focused: target }
}

export const closeSessionPane = (
  layout: SessionSurfaceLayout,
  index: number,
  fallback: SessionSurface
): SessionSurfaceLayout => {
  if (index < 0 || index >= layout.panes.length) return layout
  const closed = layout.panes[index]!.surface
  const panes = normalise(layout.panes.filter((_, paneIndex) => paneIndex !== index))
  return {
    ...layout,
    ...(closed.kind === "chat" && closed.id === layout.mainChatId ? { mainChatId: null } : {}),
    panes: panes.length > 0 ? panes : [{ surface: fallback, ratio: 1 }],
    focused: Math.min(index, Math.max(0, panes.length - 1))
  }
}

export const moveSessionPane = (
  layout: SessionSurfaceLayout,
  from: number,
  to: number
): SessionSurfaceLayout => {
  if (from < 0 || from >= layout.panes.length || to < 0 || to >= layout.panes.length || from === to) {
    return layout
  }
  const panes = [...layout.panes]
  const [pane] = panes.splice(from, 1)
  panes.splice(to, 0, pane!)
  return { ...layout, panes, focused: to }
}

export const closeSessionSurface = (
  layout: SessionSurfaceLayout,
  surface: SessionSurface,
  fallback: SessionSurface
): SessionSurfaceLayout => {
  const key = sessionSurfaceKey(surface)
  const removedAt = layout.panes.findIndex((pane) => sessionSurfaceKey(pane.surface) === key)
  const remaining = layout.panes.filter((pane) => sessionSurfaceKey(pane.surface) !== key)
  const panes = normalise(remaining.length > 0 ? remaining : [{ surface: fallback, ratio: 1 }])
  const focused =
    removedAt === -1
      ? clampFocus(layout.focused, panes.length)
      : layout.focused > removedAt
        ? layout.focused - 1
        : Math.min(layout.focused, panes.length - 1)
  return {
    ...layout,
    panes,
    focused,
    ...(surface.kind === "chat" && surface.id === layout.mainChatId ? { mainChatId: null } : {}),
    openViews:
      surface.kind === "view"
        ? layout.openViews.filter((view) => sessionSurfaceKey(view) !== key)
        : layout.openViews
  }
}

export const closeAllSessionViews = (
  layout: SessionSurfaceLayout,
  fallback: SessionSurface
): SessionSurfaceLayout => {
  const panes = normalise(layout.panes.filter((pane) => pane.surface.kind !== "view"))
  return {
    ...layout,
    panes: panes.length > 0 ? panes : [{ surface: fallback, ratio: 1 }],
    focused: clampFocus(layout.focused, panes.length || 1),
    openViews: []
  }
}

export const resizeSessionSurface = (
  layout: SessionSurfaceLayout,
  index: number,
  delta: number
): SessionSurfaceLayout => {
  const left = layout.panes[index]
  const right = layout.panes[index + 1]
  if (!((left && right ) && Number.isFinite(delta))) return layout
  const pair = left.ratio + right.ratio
  if (pair < MIN_RATIO * 2) return layout
  const nextLeft = Math.min(Math.max(left.ratio + delta, MIN_RATIO), pair - MIN_RATIO)
  if (nextLeft === left.ratio) return layout
  return {
    ...layout,
    panes: layout.panes.map((pane, paneIndex) =>
      paneIndex === index
        ? { ...pane, ratio: nextLeft }
        : paneIndex === index + 1
          ? { ...pane, ratio: pair - nextLeft }
          : pane
    )
  }
}

const isSurface = (value: unknown): value is SessionSurface => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { kind?: unknown; id?: unknown; chatId?: unknown }
  return (
    (candidate.kind === "chat" || candidate.kind === "file" || candidate.kind === "view") &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    (candidate.chatId === undefined || typeof candidate.chatId === "string")
  )
}

export const pruneSessionSurfaceLayout = (
  layout: SessionSurfaceLayout,
  allowed: ReadonlySet<string>,
  fallback: SessionSurface
): SessionSurfaceLayout => {
  const seen: SessionSurface[] = []
  const panes = normalise(
    layout.panes.filter((pane) => {
      const key = sessionSurfaceKey(pane.surface)
      if (!allowed.has(key) || seen.some((surface) => sameSurface(surface, pane.surface))) {
        return false
      }
      seen.push(pane.surface)
      return true
    })
  )
  const openViews = layout.openViews.filter((view, index, views) => {
    const key = sessionSurfaceKey(view)
    return allowed.has(key) && views.findIndex((candidate) => sameSurface(candidate, view)) === index
  })
  return {
    ...layout,
    panes: panes.length > 0 ? panes : [{ surface: fallback, ratio: 1 }],
    focused: clampFocus(layout.focused, panes.length || 1),
    openViews
  }
}

export const loadSessionSurfaceLayout = (
  sessionId: string,
  fallback: SessionSurface,
  mainChatId?: string
): SessionSurfaceLayout => {
  const initial = mainChatId
    ? openSessionSurface({ ...createSessionSurfaceLayout({ kind: "chat", id: mainChatId }), mainChatId }, fallback, MAX_PANES)
    : createSessionSurfaceLayout(fallback)
  try {
    const raw = localStorage.getItem(`${SESSION_SURFACE_STORAGE_PREFIX}${sessionId}`)
    if (raw === null) return initial
    const parsed = JSON.parse(raw) as Partial<SessionSurfaceLayout>
    if (!(Array.isArray(parsed.panes) && Array.isArray(parsed.openViews))) {
      return initial
    }
    let panes = parsed.panes
      .filter(
        (pane): pane is SessionSurfacePane =>
          typeof pane === "object" &&
          pane !== null &&
          isSurface((pane as SessionSurfacePane).surface) &&
          typeof (pane as SessionSurfacePane).ratio === "number" &&
          Number.isFinite((pane as SessionSurfacePane).ratio) &&
          (pane as SessionSurfacePane).ratio > 0
      )
    const focusedSurface = panes[clampFocus(parsed.focused ?? 0, panes.length)]?.surface
    const main = parsed.mainChatId === null ? null : mainChatId ?? (typeof parsed.mainChatId === "string" ? parsed.mainChatId : undefined)
    if (main) {
      const mainPane = panes.find((pane) => pane.surface.kind === "chat" && pane.surface.id === main)
        ?? { surface: { kind: "chat" as const, id: main }, ratio: 1 }
      const oldIndex = panes.indexOf(mainPane)
      panes = panes.filter((pane) => pane !== mainPane).slice(0, MAX_PANES - 1)
      panes.splice(Math.max(0, Math.min(oldIndex, panes.length)), 0, mainPane)
    } else {
      panes = panes.slice(0, MAX_PANES)
    }
    const openViews = parsed.openViews.filter(
      (view): view is Extract<SessionSurface, { kind: "view" }> =>
        isSurface(view) && view.kind === "view"
    )
    if (panes.length === 0) return initial
    return {
      ...(main !== undefined ? { mainChatId: main } : {}),
      panes: normalise(panes),
      focused: Math.max(0, panes.findIndex((pane) => focusedSurface && sameSurface(pane.surface, focusedSurface))),
      openViews
    }
  } catch {
    return initial
  }
}

export const saveSessionSurfaceLayout = (sessionId: string, layout: SessionSurfaceLayout): void => {
  try {
    localStorage.setItem(`${SESSION_SURFACE_STORAGE_PREFIX}${sessionId}`, JSON.stringify(layout))
  } catch {
    // The live layout still works when storage is unavailable.
  }
}
