import {
  createContext,
  type ReactNode,
  useContext
} from "react"

export interface PlanWorkerControls {
  readonly stop?: (agentId: string) => void
  readonly retry?: (agentId: string) => void
}

const PlanWorkerControlsContext = createContext<PlanWorkerControls>({})

export function PlanWorkerControlsProvider({
  controls,
  children
}: {
  controls?: PlanWorkerControls
  children: ReactNode
}) {
  return (
    <PlanWorkerControlsContext.Provider value={controls ?? {}}>
      {children}
    </PlanWorkerControlsContext.Provider>
  )
}

export const usePlanWorkerControls = (): PlanWorkerControls =>
  useContext(PlanWorkerControlsContext)
