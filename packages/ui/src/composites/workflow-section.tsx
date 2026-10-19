import type { ProjectRunCommand, WorkspaceLifecycle, WorkspaceRunState } from "@jingler/core"
import { Button } from "../components/button.js"
import { Eyebrow } from "../components/eyebrow.js"

export interface WorkflowSectionProps {
  lifecycle?: WorkspaceLifecycle
  commands: ReadonlyArray<ProjectRunCommand>
  runs: ReadonlyArray<WorkspaceRunState>
  error?: string | null
  onRetrySetup?: () => void
  onSkipSetup?: () => void
  onStartRun?: (commandId: string) => void
  onStopRun?: (commandId: string) => void
  onArchiveWithoutCleanup?: () => void
}

const summaryFor = (lifecycle: WorkspaceLifecycle | undefined, runs: ReadonlyArray<WorkspaceRunState>): string => {
  if (lifecycle?.status === "setup-running") return "Preparing workspace…"
  if (lifecycle?.status === "setup-failed") return "Setup failed"
  if (lifecycle?.status === "cleanup-failed") return "Cleanup failed"
  const failed = runs.filter((run) => run.status === "failed").length
  if (failed > 0) return `${failed} failed`
  const running = runs.filter((run) => run.status === "running").length
  if (running > 0) return `${running} running`
  return "Idle"
}

/**
 * Collapsed-by-default Workflow section for the Checks rail (`PrSidePanel`) —
 * a one-row summary that expands into the same setup/run steps and retry/skip
 * actions as the conversation's `WorkspaceWorkflowBar`, so an operator who has
 * switched to Checks isn't forced back to Conversation to unblock setup.
 */
export function WorkflowSection({
  lifecycle,
  commands,
  runs,
  error,
  onRetrySetup,
  onSkipSetup,
  onStartRun,
  onStopRun,
  onArchiveWithoutCleanup
}: WorkflowSectionProps) {
  const displayed = [...commands, ...runs.filter((run) => !commands.some((command) => command.id === run.id))]
  const failedRuns = runs.filter((run) => run.status === "failed")

  return (
    <details className="group flex-none border-b border-hairline p-4" data-testid="pr-workflow-section">
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <Eyebrow className="flex-1">Workflow</Eyebrow>
        <span className="font-mono text-[10.5px] text-dim">{summaryFor(lifecycle, runs)}</span>
      </summary>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
        {lifecycle?.status === "cleanup-failed" ? (
          <>
            <span role="alert" className="text-red">Cleanup failed: {lifecycle.error}</span>
            {onArchiveWithoutCleanup && (
              <Button size="sm" variant="danger" onClick={onArchiveWithoutCleanup}>Archive without cleanup</Button>
            )}
          </>
        ) : null}
        {lifecycle?.status === "setup-failed" ? (
          <>
            <span role="alert" className="text-red">Setup failed: {lifecycle.error}</span>
            {onRetrySetup && <Button size="sm" onClick={onRetrySetup}>Retry setup</Button>}
            {onSkipSetup && <Button size="sm" variant="outline" onClick={onSkipSetup}>Skip setup</Button>}
          </>
        ) : null}
        {(lifecycle === undefined || lifecycle.status === "ready" || lifecycle.status === "setup-skipped") &&
          displayed.map((command) => {
            const state = runs.find((candidate) => candidate.id === command.id)
            if (state?.status === "running") {
              return (
                <Button key={command.id} size="sm" variant="outline" onClick={() => onStopRun?.(command.id)}>
                  Stop {state.label}
                </Button>
              )
            }
            if (commands.some((configured) => configured.id === command.id)) {
              return (
                <Button key={command.id} size="sm" onClick={() => onStartRun?.(command.id)}>
                  Run {command.label}
                </Button>
              )
            }
            return null
          })}
        {failedRuns.map((run) => (
          <details key={`failure-${run.id}`} className="text-red">
            <summary>{run.label} failed{run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ""}</summary>
            <pre className="max-h-32 max-w-xl overflow-auto whitespace-pre-wrap text-dim">{run.output || "No command output."}</pre>
          </details>
        ))}
        {lifecycle?.output ? (
          <details>
            <summary>Command output</summary>
            <pre className="max-h-32 max-w-xl overflow-auto whitespace-pre-wrap text-dim">{lifecycle.output}</pre>
          </details>
        ) : null}
        {error ? <span role="alert" className="text-red">{error}</span> : null}
      </div>
    </details>
  )
}
