import type { Project, Session } from "@jingler/core"
import { Button } from "@jingler/ui"
import { useWorkspaceWorkflow, readyForWorkflowRuns } from "./use-workspace-workflow.js"

export function WorkspaceWorkflowBar({
  session,
  project,
  onSession
}: {
  session: Session
  project?: Project
  onSession: (session: Session) => void
}) {
  const { runs, error, commands, lifecycle, displayed, hasContent, retrySetup, skipSetup, archiveWithoutCleanup, startRun, stopRun } =
    useWorkspaceWorkflow(session, project, onSession)

  if (!hasContent) return null

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2 text-xs" data-testid="workspace-workflow-bar">
      {lifecycle?.status === "setup-running" ? <span role="status" className="text-dim">Preparing workspace…</span> : null}
      {lifecycle?.status === "cleanup-failed" ? (
        <>
          <span role="alert" className="text-red">Cleanup failed: {lifecycle.error}</span>
          <Button size="sm" variant="danger" onClick={archiveWithoutCleanup}>Archive without cleanup</Button>
        </>
      ) : null}
      {lifecycle?.status === "setup-failed" ? (
        <>
          <span role="alert" className="text-red">Setup failed: {lifecycle.error}</span>
          <Button size="sm" onClick={retrySetup}>Retry setup</Button>
          <Button size="sm" variant="outline" onClick={skipSetup}>Skip setup</Button>
        </>
      ) : null}
      {readyForWorkflowRuns(lifecycle) ? displayed.map((command) => {
        const state = runs.find((candidate) => candidate.id === command.id)
        return state?.status === "running" ? (
          <Button key={command.id} size="sm" variant="outline" onClick={() => void stopRun(command.id)}>Stop {state.label}</Button>
        ) : commands.some(configured => configured.id === command.id) ? (
          <Button key={command.id} size="sm" onClick={() => void startRun(command.id)}>Run {command.label}</Button>
        ) : null
      }) : null}
      {runs.filter(run => run.status === "failed").map(run => <details key={`failure-${run.id}`} className="text-red">
        <summary>{run.label} failed{run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ""}</summary>
        <pre className="max-h-32 max-w-xl overflow-auto whitespace-pre-wrap text-dim">{run.output || "No command output."}</pre>
      </details>)}
      {lifecycle?.output ? <details><summary>Command output</summary><pre className="max-h-32 max-w-xl overflow-auto whitespace-pre-wrap text-dim">{lifecycle.output}</pre></details> : null}
      {error ? <span role="alert" className="text-red">{error}</span> : null}
    </div>
  )
}
