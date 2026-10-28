import { useMemo } from "react"
import { useMachine } from "@xstate/react"
import { explorerViewMachine, type SidebarMode, type ExplorerFilter } from "./explorer-view-machine.js"

export interface UseExplorerViewResult {
  readonly mode: SidebarMode
  readonly filter: ExplorerFilter
  readonly setMode: (mode: SidebarMode) => void
  readonly toggleMode: () => void
  readonly setFilter: (filter: ExplorerFilter) => void
  readonly setProject: (path: string | null) => void
  readonly revealChanges: () => void
}

export function useExplorerView(currentProjectPath: string | null): UseExplorerViewResult {
  const [state, send] = useMachine(explorerViewMachine, {
    input: { currentProjectPath }
  })

  return useMemo(
    () => ({
      mode: state.context.mode,
      filter: state.context.filter,
      setMode: (mode: SidebarMode) => send({ type: "SET_MODE", mode }),
      toggleMode: () => send({ type: "TOGGLE_MODE" }),
      setFilter: (filter: ExplorerFilter) => send({ type: "SET_FILTER", filter }),
      setProject: (path: string | null) => send({ type: "SET_PROJECT", path }),
      revealChanges: () => send({ type: "REVEAL_CHANGES" })
    }),
    [state.context.mode, state.context.filter, send]
  )
}
