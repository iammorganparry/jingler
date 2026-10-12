import { setup, assign, fromCallback } from "xstate"

export type SidebarMode = "sessions" | "explorer"
export type ExplorerFilter = "all" | "local" | "pr"

export interface ExplorerViewContext {
  readonly mode: SidebarMode
  readonly filter: ExplorerFilter
  /** Per-project filter memory: projectPath → last-used filter. */
  readonly projectMemory: ReadonlyMap<string, ExplorerFilter>
  readonly currentProjectPath: string | null
}

export type ExplorerViewEvent =
  | { type: "TOGGLE_MODE" }
  | { type: "SET_MODE"; mode: SidebarMode }
  | { type: "SET_FILTER"; filter: ExplorerFilter }
  | { type: "SET_PROJECT"; path: string | null }
  | { type: "REVEAL_CHANGES" }

const STORAGE_KEY = "jingler:explorer-view-state"

function loadPersistedState(): Pick<ExplorerViewContext, "mode" | "projectMemory"> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return { mode: "sessions", projectMemory: new Map() }
    const parsed = JSON.parse(stored)
    return {
      mode: parsed.mode ?? "sessions",
      projectMemory: new Map(Object.entries(parsed.projectMemory ?? {}))
    }
  } catch {
    return { mode: "sessions", projectMemory: new Map() }
  }
}

function persistState(context: ExplorerViewContext): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        mode: context.mode,
        projectMemory: Object.fromEntries(context.projectMemory)
      })
    )
  } catch {
    // Ignore persistence errors
  }
}

export const explorerViewMachine = setup({
  types: {
    context: {} as ExplorerViewContext,
    events: {} as ExplorerViewEvent,
    input: {} as Partial<ExplorerViewContext> | undefined
  },
  actions: {
    toggleMode: assign({
      mode: ({ context }) => (context.mode === "sessions" ? "explorer" : "sessions")
    }),
    setMode: assign({
      mode: ({ event }) => (event as { mode: SidebarMode }).mode
    }),
    setFilter: assign(({ context, event }) => {
      const filter = (event as { filter: ExplorerFilter }).filter
      const { currentProjectPath } = context
      const projectMemory = currentProjectPath
        ? new Map(context.projectMemory).set(currentProjectPath, filter)
        : context.projectMemory
      return { filter, projectMemory }
    }),
    setProject: assign(({ context, event }) => {
      const path = (event as { path: string | null }).path
      const remembered = path ? context.projectMemory.get(path) : null
      return {
        currentProjectPath: path,
        filter: remembered ?? context.filter
      }
    }),
    revealChanges: assign({
      mode: "explorer",
      filter: ({ context }) => {
        // Prefer PR if available, else local
        const { currentProjectPath } = context
        const remembered = currentProjectPath ? context.projectMemory.get(currentProjectPath) : null
        return remembered === "pr" || remembered === "local" ? remembered : "local"
      }
    }),
    persist: ({ context }) => {
      persistState(context)
    }
  }
}).createMachine({
  id: "explorerView",
  initial: "active",
  context: ({ input }) => {
    const persisted = loadPersistedState()
    return {
      mode: input?.mode ?? persisted.mode,
      filter: input?.filter ?? "all",
      projectMemory: persisted.projectMemory,
      currentProjectPath: input?.currentProjectPath ?? null
    }
  },
  states: {
    active: {
      on: {
        TOGGLE_MODE: {
          actions: ["toggleMode", "persist"]
        },
        SET_MODE: {
          actions: ["setMode", "persist"]
        },
        SET_FILTER: {
          actions: ["setFilter", "persist"]
        },
        SET_PROJECT: {
          actions: "setProject"
        },
        REVEAL_CHANGES: {
          actions: ["revealChanges", "persist"]
        }
      }
    }
  }
})
