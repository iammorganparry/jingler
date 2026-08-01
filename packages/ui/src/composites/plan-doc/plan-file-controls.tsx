import { createContext, useContext, useMemo, type ReactNode } from "react"

export interface PlanFileEvidence {
  readonly change: "A" | "M" | "D" | "R"
  readonly added: number
  readonly removed: number
}

export interface PlanFileControls {
  readonly evidence?: ReadonlyMap<string, PlanFileEvidence>
  readonly knownFiles?: ReadonlySet<string>
  readonly open?: (path: string) => void
}

const PlanFileControlsContext = createContext<PlanFileControls>({})

export function PlanFileControlsProvider({
  evidence,
  knownFiles,
  open,
  children
}: PlanFileControls & { readonly children: ReactNode }) {
  const controls = useMemo(
    () => ({ evidence, knownFiles, open }),
    [evidence, knownFiles, open]
  )
  return (
    <PlanFileControlsContext.Provider value={controls}>
      {children}
    </PlanFileControlsContext.Provider>
  )
}

export const usePlanFileControls = (): PlanFileControls =>
  useContext(PlanFileControlsContext)
