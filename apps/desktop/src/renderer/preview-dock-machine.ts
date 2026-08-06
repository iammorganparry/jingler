/** Session-scoped browser Preview state with one focused native overlay. */
import type { DockSide } from "@jingler/ui"
import { assign, setup } from "xstate"

export const DEFAULT_PREVIEW_URL = "http://localhost:3000"
const SESSIONS_KEY = "jingler.browser.sessions.v1"
const SIDE_KEY = "jingler.browser.side"
const LEGACY_VISIBLE_KEY = "jingler.browser.visible"
const LEGACY_ASSET_TABS_KEY = "jingler.preview.tabs"

export interface PreviewSessionState {
  readonly url: string
  readonly visible: boolean
  readonly source: "operator" | "native"
}

export interface PreviewDockContext {
  readonly focusedSessionId: string | null
  readonly sessions: Readonly<Record<string, PreviewSessionState>>
  readonly side: DockSide
  readonly legacyVisible: boolean
}

export type PreviewDockEvent =
  | { readonly type: "FOCUS_SESSION"; readonly sessionId: string | null }
  | { readonly type: "TOGGLE"; readonly sessionId?: string }
  | { readonly type: "SET_SIDE"; readonly side: DockSide }
  | { readonly type: "NAVIGATE"; readonly sessionId: string; readonly url: string }
  | { readonly type: "NATIVE_URL"; readonly sessionId: string; readonly url: string }
  | { readonly type: "REVEAL_BROWSER"; readonly sessionId: string; readonly url: string }
  | { readonly type: "REMOVE_SESSION"; readonly sessionId: string }

const defaultSessionState = (visible = false): PreviewSessionState => ({
  url: DEFAULT_PREVIEW_URL,
  visible,
  source: "operator"
})

const readSide = (): DockSide => {
  try {
    return localStorage.getItem(SIDE_KEY) === "bottom" ? "bottom" : "right"
  } catch {
    return "right"
  }
}

const readLegacyVisible = (): boolean => {
  try {
    return localStorage.getItem(LEGACY_VISIBLE_KEY) === "true"
  } catch {
    return false
  }
}

const readSessions = (): Readonly<Record<string, PreviewSessionState>> => {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    const sessions: Record<string, PreviewSessionState> = {}
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null) continue
      const url = "url" in value && typeof value.url === "string" ? value.url : DEFAULT_PREVIEW_URL
      const visible = "visible" in value && value.visible === true
      sessions[sessionId] = { url, visible, source: "native" }
    }
    return sessions
  } catch {
    return {}
  }
}

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}

const persistSessions = (sessions: Readonly<Record<string, PreviewSessionState>>): void => {
  write(SESSIONS_KEY, JSON.stringify(sessions))
}

const initializeStorage = (): void => {
  try {
    localStorage.removeItem(LEGACY_ASSET_TABS_KEY)
    localStorage.removeItem(LEGACY_VISIBLE_KEY)
  } catch {
    /* ignore privacy-mode failures */
  }
}

const sessionFor = (
  context: PreviewDockContext,
  sessionId: string
): PreviewSessionState =>
  context.sessions[sessionId] ??
  defaultSessionState(Object.keys(context.sessions).length === 0 && context.legacyVisible)

const updateSession = (
  context: PreviewDockContext,
  sessionId: string,
  update: (current: PreviewSessionState) => PreviewSessionState
) => {
  const sessions = { ...context.sessions, [sessionId]: update(sessionFor(context, sessionId)) }
  persistSessions(sessions)
  return sessions
}

export const previewDockMachine = setup({
  types: {
    context: {} as PreviewDockContext,
    events: {} as PreviewDockEvent
  },
  actions: {
    focusSession: assign(({ context, event }) => {
      if (event.type !== "FOCUS_SESSION") return {}
      if (event.sessionId === null) return { focusedSessionId: null }
      const sessions = updateSession(context, event.sessionId, (current) => current)
      return { focusedSessionId: event.sessionId, sessions }
    }),
    toggle: assign(({ context, event }) => {
      if (event.type !== "TOGGLE") return {}
      const sessionId = event.sessionId ?? context.focusedSessionId
      if (sessionId === null) return {}
      return {
        sessions: updateSession(context, sessionId, (current) => ({
          ...current,
          visible: !current.visible
        }))
      }
    }),
    setSide: assign(({ event }) => {
      if (event.type !== "SET_SIDE") return {}
      write(SIDE_KEY, event.side)
      return { side: event.side }
    }),
    navigate: assign(({ context, event }) => {
      if (event.type !== "NAVIGATE") return {}
      return {
        sessions: updateSession(context, event.sessionId, (current) => ({
          ...current,
          url: event.url,
          source: "operator"
        }))
      }
    }),
    nativeUrl: assign(({ context, event }) => {
      if (event.type !== "NATIVE_URL" || event.url.length === 0) return {}
      return {
        sessions: updateSession(context, event.sessionId, (current) => ({
          ...current,
          url: event.url,
          source: "native"
        }))
      }
    }),
    revealBrowser: assign(({ context, event }) => {
      if (event.type !== "REVEAL_BROWSER") return {}
      return {
        sessions: updateSession(context, event.sessionId, (current) => ({
          ...current,
          ...(event.url.length === 0 ? {} : { url: event.url }),
          visible: true,
          source: "native"
        }))
      }
    }),
    removeSession: assign(({ context, event }) => {
      if (event.type !== "REMOVE_SESSION") return {}
      const { [event.sessionId]: _removed, ...sessions } = context.sessions
      persistSessions(sessions)
      return {
        sessions,
        focusedSessionId:
          context.focusedSessionId === event.sessionId ? null : context.focusedSessionId
      }
    })
  }
}).createMachine({
  id: "previewDock",
  context: () => {
    const sessions = readSessions()
    const legacyVisible = readLegacyVisible()
    initializeStorage()
    return { focusedSessionId: null, sessions, side: readSide(), legacyVisible }
  },
  initial: "active",
  states: {
    active: {
      on: {
        FOCUS_SESSION: { actions: "focusSession" },
        TOGGLE: { actions: "toggle" },
        SET_SIDE: { actions: "setSide" },
        NAVIGATE: { actions: "navigate" },
        NATIVE_URL: { actions: "nativeUrl" },
        REVEAL_BROWSER: { actions: "revealBrowser" },
        REMOVE_SESSION: { actions: "removeSession" }
      }
    }
  }
})

export const previewSessionState = (
  context: PreviewDockContext,
  sessionId: string | null
): PreviewSessionState =>
  sessionId === null ? defaultSessionState() : sessionFor(context, sessionId)
