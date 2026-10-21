import * as React from "react"
import type { SessionCreationPhase } from "@jingler/contracts"
import type { ManagedEnvironmentState } from "@jingler/core"
import { Check, LoaderCircle, X } from "lucide-react"
import { Button } from "../components/button.js"
import { Pill } from "../components/pill.js"
import { Spin } from "../components/spin.js"
import { cn } from "../lib/cn.js"

const ROWS = ["Creating worktree", "Installing dependencies", "Starting agent"] as const

/** Which of the three rows a creation phase falls under. */
export const provisioningRowIndex = (phase: SessionCreationPhase | null): number =>
  phase === "ready" ? ROWS.length : phase === "starting-sandbox" ? 1 : 0

function RowIcon({ status }: { status: "done" | "current" | "failed" | "pending" }) {
  if (status === "done") return <Check size={14} aria-hidden />
  if (status === "failed") return <X size={14} aria-hidden className="text-state-failed" />
  if (status === "current") return <Spin><LoaderCircle size={14} aria-hidden /></Spin>
  return <span className="size-1 rounded-full bg-current" aria-hidden />
}

/** The composer's replacement while a workspace is created: phase rows + Cancel, or Retry / Edit on failure. */
export function WorkspaceProvisioning({ phase, failedPhase, error, onCancel, onRetry, onEdit }: {
  phase: SessionCreationPhase | null
  failedPhase?: SessionCreationPhase | null
  error?: string | null
  onCancel: () => void
  onRetry: () => void
  onEdit: () => void
}) {
  const failed = failedPhase !== undefined && failedPhase !== null || error != null
  const current = provisioningRowIndex(failed ? (failedPhase ?? phase) : phase)
  return (
    <section className="m-auto w-full max-w-[560px] rounded-2xl border border-line bg-panel p-8" aria-label="Workspace provisioning" aria-live="polite" data-testid="workspace-provisioning">
      <ol className="flex flex-col gap-3" aria-label="Provisioning steps">
        {ROWS.map((label, index) => {
          const status = index < current ? "done" : index > current ? "pending" : failed ? "failed" : "current"
          return (
            <li key={label} data-status={status} className={cn("flex items-center gap-3 text-[12.5px]", status === "pending" ? "text-dim" : "text-text-bright")}>
              <span className="flex size-6 flex-none items-center justify-center"><RowIcon status={status} /></span>
              {label}
            </li>
          )
        })}
      </ol>
      {error && <p role="alert" className="mt-4 text-[11px] text-muted-foreground">{error}</p>}
      <div className="mt-6 flex justify-end gap-2">
        {failed
          ? <><Button variant="secondary" onClick={onEdit}>Edit</Button><Button onClick={onRetry}>Retry</Button></>
          : <Button variant="secondary" onClick={onCancel}>Cancel</Button>}
      </div>
    </section>
  )
}

const WAKING: ReadonlyArray<ManagedEnvironmentState> = ["provisioning", "sleeping", "restoring"]
export const showsWakeChip = (state: ManagedEnvironmentState): boolean =>
  WAKING.includes(state) || state === "paused" || state === "failed"

const useElapsedSeconds = (): number => {
  const [seconds, setSeconds] = React.useState(0)
  React.useEffect(() => {
    const id = setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => clearInterval(id)
  }, [])
  return seconds
}

/** Header chip for a managed environment that is not online yet. */
export function EnvironmentWakeChip({ state, reason, onWake }: {
  state: ManagedEnvironmentState
  reason?: string
  onWake?: () => void
}) {
  const elapsed = useElapsedSeconds()
  if (WAKING.includes(state)) return <Pill tone="yellow" pulse>Waking workspace… {elapsed}s</Pill>
  if (state === "paused") {
    return <span className="flex items-center gap-1"><Pill tone="yellow">Paused</Pill>{onWake && <Button size="sm" variant="secondary" onClick={onWake}>Resume</Button>}</span>
  }
  return <span className="flex items-center gap-1"><Pill tone="red">{reason ?? "Workspace failed"}</Pill>{onWake && <Button size="sm" variant="secondary" onClick={onWake}>Retry</Button>}</span>
}
