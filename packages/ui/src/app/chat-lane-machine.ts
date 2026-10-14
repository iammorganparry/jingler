/**
 * Chat lane modes (docs/ux-audit/03-redesign-spec.md §3b, §3d): Full, Docked, Collapsed, Focus,
 * and the narrow-window overlay Drawer. The lane keeps a remembered pixel width, not a ratio.
 */
import { assign, setup, type SnapshotFrom } from "xstate"
import { chatLaneIsDrawer, SHELL_BREAKPOINTS } from "../hooks/width-tier.js"

export const CHAT_LANE_WIDTH_KEY = "sb.chat-lane.width"
/** Hard floor: dragging below this collapses the lane instead of squashing it. */
export const CHAT_LANE_MIN_WIDTH = 320
/** Default docked width is clamp(360px, 1/3 of the window, 560px). */
export const CHAT_LANE_DEFAULT_MIN = 360
export const CHAT_LANE_DEFAULT_MAX = 560
export const CHAT_LANE_DRAWER_WIDTH = 400
/** Windows narrower than this swap Docked for the overlay Drawer. */
export const CHAT_LANE_NARROW_BELOW = SHELL_BREAKPOINTS.chatDrawerBelow
export const CHAT_LANE_SNAP_RATIOS = [1 / 3, 1 / 2] as const
export const CHAT_LANE_SNAP_TOLERANCE = 16

export type ChatLaneMode = "full" | "docked" | "collapsed" | "focus" | "drawer"
type FocusReturn = "docked" | "collapsed"

export interface ChatLaneInput {
  readonly windowWidth: number
  readonly contentOpen: boolean
}

export interface ChatLaneContext {
  readonly windowWidth: number
  /** The user's remembered docked width in px; null until they resize (then the default applies). */
  readonly width: number | null
  /** Only read once, to pick the first state. */
  readonly initialContentOpen: boolean
  /** Mode that leaving Focus restores. */
  readonly focusReturn: FocusReturn
}

export type ChatLaneEvent =
  | { readonly type: "OPEN_CONTENT" }
  | { readonly type: "CLOSE_CONTENT" }
  | { readonly type: "TOGGLE_COLLAPSE" }
  | { readonly type: "TOGGLE_FOCUS" }
  | { readonly type: "RESIZE"; readonly width: number }
  | { readonly type: "RESET_WIDTH" }
  | { readonly type: "WINDOW_RESIZE"; readonly width: number }

export const isNarrowWindow = chatLaneIsDrawer

export const defaultLaneWidth = (windowWidth: number): number =>
  Math.min(CHAT_LANE_DEFAULT_MAX, Math.max(CHAT_LANE_DEFAULT_MIN, Math.round(windowWidth / 3)))

/** A dragged width resolved to a persisted px width (snapped to 1/3 or 1/2), or null to collapse. */
export const resolveLaneResize = (rawWidth: number, windowWidth: number): number | null => {
  if (rawWidth < CHAT_LANE_MIN_WIDTH) return null
  const snap = CHAT_LANE_SNAP_RATIOS.map((ratio) => Math.round(windowWidth * ratio)).find(
    (point) => Math.abs(rawWidth - point) <= CHAT_LANE_SNAP_TOLERANCE
  )
  return snap ?? Math.round(rawWidth)
}

const readWidth = (): number | null => {
  try {
    const stored = Number(localStorage.getItem(CHAT_LANE_WIDTH_KEY))
    return Number.isFinite(stored) && stored >= CHAT_LANE_MIN_WIDTH ? stored : null
  } catch {
    return null
  }
}

const writeWidth = (width: number | null): void => {
  try {
    if (width === null) localStorage.removeItem(CHAT_LANE_WIDTH_KEY)
    else localStorage.setItem(CHAT_LANE_WIDTH_KEY, String(width))
  } catch {
    /* in-memory width still works */
  }
}

export const chatLaneMachine = setup({
  types: {
    context: {} as ChatLaneContext,
    events: {} as ChatLaneEvent,
    input: {} as ChatLaneInput
  },
  guards: {
    startsEmpty: ({ context }) => !context.initialContentOpen,
    startsNarrow: ({ context }) => isNarrowWindow(context.windowWidth),
    windowIsNarrow: ({ context }) => isNarrowWindow(context.windowWidth),
    resizeCollapses: ({ context, event }) =>
      event.type === "RESIZE" && resolveLaneResize(event.width, context.windowWidth) === null,
    returnsToCollapsed: ({ context }) => context.focusReturn === "collapsed"
  },
  actions: {
    setWindowWidth: assign(({ event }) =>
      event.type === "WINDOW_RESIZE" ? { windowWidth: event.width } : {}
    ),
    setWidth: assign(({ context, event }) => {
      if (event.type !== "RESIZE") return {}
      const width = resolveLaneResize(event.width, context.windowWidth)
      if (width === null) return {}
      writeWidth(width)
      return { width }
    }),
    resetWidth: assign(() => {
      writeWidth(null)
      return { width: null }
    }),
    focusFromDocked: assign({ focusReturn: "docked" as FocusReturn }),
    focusFromCollapsed: assign({ focusReturn: "collapsed" as FocusReturn })
  }
}).createMachine({
  id: "chatLane",
  context: ({ input }) => ({
    windowWidth: input.windowWidth,
    width: readWidth(),
    initialContentOpen: input.contentOpen,
    focusReturn: "docked"
  }),
  initial: "boot",
  states: {
    boot: {
      always: [
        { guard: "startsEmpty", target: "full" },
        { guard: "startsNarrow", target: "drawer" },
        { target: "docked" }
      ]
    },
    // No content open: the transcript fills the area, even in a narrow window.
    full: {
      on: {
        OPEN_CONTENT: [{ guard: "windowIsNarrow", target: "drawer" }, { target: "docked" }],
        WINDOW_RESIZE: { actions: "setWindowWidth" }
      }
    },
    docked: {
      on: {
        CLOSE_CONTENT: "full",
        TOGGLE_COLLAPSE: "collapsed",
        TOGGLE_FOCUS: { target: "focus", actions: "focusFromDocked" },
        RESIZE: [{ guard: "resizeCollapses", target: "collapsed" }, { actions: "setWidth" }],
        RESET_WIDTH: { actions: "resetWidth" },
        WINDOW_RESIZE: [
          { guard: ({ event }) => isNarrowWindow(event.width), target: "drawer", actions: "setWindowWidth" },
          { actions: "setWindowWidth" }
        ]
      }
    },
    collapsed: {
      on: {
        CLOSE_CONTENT: "full",
        TOGGLE_COLLAPSE: "docked",
        TOGGLE_FOCUS: { target: "focus", actions: "focusFromCollapsed" },
        WINDOW_RESIZE: [
          { guard: ({ event }) => isNarrowWindow(event.width), target: "drawer", actions: "setWindowWidth" },
          { actions: "setWindowWidth" }
        ]
      }
    },
    focus: {
      on: {
        CLOSE_CONTENT: "full",
        TOGGLE_FOCUS: [{ guard: "returnsToCollapsed", target: "collapsed" }, { target: "docked" }],
        WINDOW_RESIZE: [
          { guard: ({ event }) => isNarrowWindow(event.width), target: "drawer", actions: "setWindowWidth" },
          { actions: "setWindowWidth" }
        ]
      }
    },
    drawer: {
      initial: "closed",
      states: {
        closed: { on: { TOGGLE_COLLAPSE: "open" } },
        open: { on: { TOGGLE_COLLAPSE: "closed" } }
      },
      on: {
        CLOSE_CONTENT: "full",
        WINDOW_RESIZE: [
          { guard: ({ event }) => !isNarrowWindow(event.width), target: "docked", actions: "setWindowWidth" },
          { actions: "setWindowWidth" }
        ]
      }
    }
  }
})

export type ChatLaneSnapshot = SnapshotFrom<typeof chatLaneMachine>

const MODES: ReadonlyArray<ChatLaneMode> = ["full", "docked", "collapsed", "focus", "drawer"]

export const chatLaneMode = (snapshot: ChatLaneSnapshot): ChatLaneMode =>
  MODES.find((mode) => snapshot.matches(mode)) ?? "full"

/** What the layout needs from a snapshot. `widthPx` is null when the lane is not a fixed-width column. */
export interface ChatLaneView {
  readonly mode: ChatLaneMode
  readonly widthPx: number | null
  readonly drawerOpen: boolean
  /** Focus keeps content tabs open but hides them. */
  readonly contentHidden: boolean
  /** Collapsed shows the floating "Ask ⌘L" pill. */
  readonly showAskPill: boolean
}

export const chatLaneView = (snapshot: ChatLaneSnapshot): ChatLaneView => {
  const mode = chatLaneMode(snapshot)
  return {
    mode,
    widthPx:
      mode === "docked"
        ? (snapshot.context.width ?? defaultLaneWidth(snapshot.context.windowWidth))
        : mode === "drawer"
          ? CHAT_LANE_DRAWER_WIDTH
          : null,
    drawerOpen: snapshot.matches({ drawer: "open" }),
    contentHidden: mode === "focus",
    showAskPill: mode === "collapsed"
  }
}
