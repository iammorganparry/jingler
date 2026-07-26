/**
 * previewDockMachine — the Preview dock's chrome state: visibility, docked side,
 * and which asset tabs are open.
 *
 * ## Why a machine and not four `useState`s
 *
 * Visibility, side, the open-asset list and the active tab are not independent:
 * opening an asset appends a tab, focuses it AND shows the dock; closing the
 * focused tab has to fall back to a tab that still exists; and three of the four
 * have to be mirrored into localStorage on every change. As plain hooks that
 * meant setters calling setters, and a `write()` next to each one that could be
 * forgotten. Here `visible` is a *state* (`hidden`/`shown`) rather than a
 * boolean, persistence is an entry/transition action, and every rule about what
 * moves together lives in one transition.
 *
 * ## What is persisted, and what deliberately is not
 *
 * Visibility, side and the LIST OF OPEN PATHS go to localStorage. Contents never
 * do: an asset is a file on disk that the agent is probably still editing, so a
 * cached copy would reopen the app showing a version that no longer exists. Tabs
 * restore as paths and re-read on mount.
 *
 * The browser tab is pinned, always first, and never closes — the dock needs a
 * stable identity when no assets are open, and "close the last tab" would
 * otherwise leave a panel of pure chrome.
 *
 * Everything here is renderer state. The browser's actual page, history and
 * scroll live in the main process (its `WebContentsView`); this only says
 * whether and where the dock shows.
 */
import type { DockSide } from "@starbase/ui"
import { BROWSER_TAB_ID } from "@starbase/ui"
import { assign, setup } from "xstate"

const VISIBLE_KEY = "starbase.browser.visible"
const SIDE_KEY = "starbase.browser.side"
const TABS_KEY = "starbase.preview.tabs"

/** An open asset tab, as persisted. Keyed by session so a path is unambiguous. */
export interface OpenAsset {
  sessionId: string
  /** Worktree-relative. Re-read from disk on restore; never cached. */
  path: string
}

/** Tab ids are `${sessionId}:${path}` so reopening the same file focuses it. */
export const assetTabId = (sessionId: string, path: string): string => `${sessionId}:${path}`

// Hidden by default — the preview dock is opt-in (unlike the terminal dock).
const readVisible = (): boolean => {
  try {
    return localStorage.getItem(VISIBLE_KEY) === "true"
  } catch {
    return false
  }
}

const readSide = (): DockSide => {
  try {
    return localStorage.getItem(SIDE_KEY) === "bottom" ? "bottom" : "right"
  } catch {
    return "right"
  }
}

/**
 * Restored tabs are validated field by field rather than cast.
 *
 * This value is JSON from localStorage — the one input here that a previous
 * version of the app wrote and this one has to survive. A shape change that
 * `as`-cast would surface as `undefined.split` inside a render, taking the whole
 * dock down; dropping the malformed entries costs an open tab instead.
 */
const readTabs = (): ReadonlyArray<OpenAsset> => {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): ReadonlyArray<OpenAsset> => {
      if (typeof entry !== "object" || entry === null) return []
      const { sessionId, path } = entry as Partial<OpenAsset>
      return typeof sessionId === "string" && typeof path === "string" ? [{ sessionId, path }] : []
    })
  } catch {
    return []
  }
}

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}

export interface PreviewDockContext {
  /**
   * What localStorage said at spawn. Read once by the `restoring` guard and then
   * never again — `hidden`/`shown` is the live answer. A machine's `initial` has
   * to be static, so restored visibility arrives as context and an `always`.
   */
  readonly restoredVisible: boolean
  readonly side: DockSide
  readonly assets: ReadonlyArray<OpenAsset>
  readonly activeId: string
}

export type PreviewDockEvent =
  | { type: "TOGGLE" }
  | { type: "SET_SIDE"; side: DockSide }
  | { type: "SELECT"; id: string }
  | { type: "OPEN_ASSET"; sessionId: string; path: string }
  | { type: "CLOSE"; id: string }

export const previewDockMachine = setup({
  types: {
    context: {} as PreviewDockContext,
    events: {} as PreviewDockEvent
  },
  actions: {
    persistVisible: (_, params: { visible: boolean }) => {
      write(VISIBLE_KEY, String(params.visible))
    },
    setSide: assign(({ event }) => {
      if (event.type !== "SET_SIDE") return {}
      write(SIDE_KEY, event.side)
      return { side: event.side }
    }),
    select: assign(({ event }) => (event.type === "SELECT" ? { activeId: event.id } : {})),
    // Reopening an already-open file focuses its tab. Appending a duplicate
    // would give two tabs with the same title that can never diverge.
    openAsset: assign(({ context, event }) => {
      if (event.type !== "OPEN_ASSET") return {}
      const { sessionId, path } = event
      const assets = context.assets.some((a) => a.sessionId === sessionId && a.path === path)
        ? context.assets
        : [...context.assets, { sessionId, path }]
      write(TABS_KEY, JSON.stringify(assets))
      return { assets, activeId: assetTabId(sessionId, path) }
    }),
    closeAsset: assign(({ context, event }) => {
      if (event.type !== "CLOSE") return {}
      const assets = context.assets.filter((a) => assetTabId(a.sessionId, a.path) !== event.id)
      write(TABS_KEY, JSON.stringify(assets))
      // Falling back to the browser rather than to a neighbouring asset: the
      // browser is the only tab guaranteed to still be there.
      return {
        assets,
        activeId: context.activeId === event.id ? BROWSER_TAB_ID : context.activeId
      }
    })
  },
  guards: {
    // The pinned browser tab has no close button, but a stray CLOSE for it would
    // otherwise re-persist an unchanged list and re-enter `shown`.
    isAssetTab: (_, params: { id: string }) => params.id !== BROWSER_TAB_ID
  }
}).createMachine({
  id: "previewDock",
  context: () => ({
    restoredVisible: readVisible(),
    side: readSide(),
    assets: readTabs(),
    activeId: BROWSER_TAB_ID
  }),
  initial: "restoring",
  // Side, selection and closing are orthogonal to visibility, so they live on
  // the root and apply in both states.
  on: {
    SET_SIDE: { actions: "setSide" },
    SELECT: { actions: "select" },
    CLOSE: {
      guard: { type: "isAssetTab", params: ({ event }) => ({ id: event.id }) },
      actions: "closeAsset"
    },
    // Opening an asset is an explicit request to LOOK at it, so it shows the
    // dock. Focusing a tab in a hidden panel would look like nothing happened.
    OPEN_ASSET: { target: ".shown", actions: "openAsset" }
  },
  states: {
    restoring: {
      always: [
        { guard: ({ context }) => context.restoredVisible, target: "shown" },
        { target: "hidden" }
      ]
    },
    hidden: {
      entry: { type: "persistVisible", params: { visible: false } },
      on: { TOGGLE: "shown" }
    },
    shown: {
      entry: { type: "persistVisible", params: { visible: true } },
      on: { TOGGLE: "hidden" }
    }
  }
})
