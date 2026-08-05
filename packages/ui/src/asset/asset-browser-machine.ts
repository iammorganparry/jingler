import { assign, setup } from "xstate"

const DEFAULT_TREE_WIDTH = 240
const MIN_TREE_WIDTH = 180
const MAX_TREE_WIDTH = 420

const clampTreeWidth = (width: number): number =>
  Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, Math.round(width)))

const readWidth = (key: string): number => {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0
      ? clampTreeWidth(value)
      : DEFAULT_TREE_WIDTH
  } catch {
    return DEFAULT_TREE_WIDTH
  }
}

const writeWidth = (key: string, width: number): void => {
  try {
    localStorage.setItem(key, String(width))
  } catch {
    // Persistence is an enhancement; privacy mode must not break the browser.
  }
}

export interface AssetBrowserMachineInput {
  readonly storageKey: string
}

export interface AssetBrowserMachineContext {
  readonly storageKey: string
  readonly treeWidth: number
  readonly resizing: boolean
}

export type AssetBrowserMachineEvent =
  | { type: "SET_CONSTRAINED"; constrained: boolean }
  | { type: "TOGGLE_TREE" }
  | { type: "CLOSE_TREE" }
  | { type: "SELECT_PATH" }
  | { type: "START_RESIZE" }
  | { type: "END_RESIZE" }
  | { type: "RESIZE_TREE"; delta: number; max: number }

export const assetBrowserMachine = setup({
  types: {
    input: {} as AssetBrowserMachineInput,
    context: {} as AssetBrowserMachineContext,
    events: {} as AssetBrowserMachineEvent
  },
  guards: {
    constrained: ({ event }) =>
      event.type === "SET_CONSTRAINED" && event.constrained,
    roomy: ({ event }) =>
      event.type === "SET_CONSTRAINED" && !event.constrained
  },
  actions: {
    resizeTree: assign(({ context, event }) => {
      if (event.type !== "RESIZE_TREE") return {}
      const width = clampTreeWidth(
        Math.min(context.treeWidth + event.delta, Math.max(MIN_TREE_WIDTH, event.max))
      )
      writeWidth(context.storageKey, width)
      return { treeWidth: width }
    }),
    startResize: assign(() => ({ resizing: true })),
    endResize: assign(() => ({ resizing: false }))
  }
}).createMachine({
  id: "assetBrowser",
  context: ({ input }) => ({
    storageKey: input.storageKey,
    treeWidth: readWidth(input.storageKey),
    resizing: false
  }),
  initial: "roomy",
  on: {
    RESIZE_TREE: { actions: "resizeTree" },
    START_RESIZE: { actions: "startResize" },
    END_RESIZE: { actions: "endResize" }
  },
  states: {
    roomy: {
      on: {
        SET_CONSTRAINED: {
          guard: "constrained",
          target: "constrained.closed"
        }
      }
    },
    constrained: {
      initial: "closed",
      on: {
        SET_CONSTRAINED: {
          guard: "roomy",
          target: "roomy"
        },
        SELECT_PATH: { target: ".closed" },
        CLOSE_TREE: { target: ".closed" }
      },
      states: {
        closed: {
          on: { TOGGLE_TREE: "open" }
        },
        open: {
          on: { TOGGLE_TREE: "closed" }
        }
      }
    }
  }
})

export const assetBrowserTreeLimits = {
  default: DEFAULT_TREE_WIDTH,
  min: MIN_TREE_WIDTH,
  max: MAX_TREE_WIDTH
} as const
