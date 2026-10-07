import { WorkspaceCheckpointsView } from "./workspace-checkpoints-view.js"
import { useEffect, useState } from "react"
import type { Project, Session, WorkspaceRunState } from "@jingler/core"
import { Button } from "@jingler/ui"
import { rpc } from "./rpc-client.js"

const readyForRuns = (lifecycle: Session["workspaceLifecycle"]): boolean =>
  lifecycle === undefined || lifecycle.status === "ready" || lifecycle.status === "setup-skipped"

export function WorkspaceWorkflowBar({
  session,
  project,
  onSession,
  onPreview
}: {
  session: Session
  project?: Project
  onSession: (session: Session) => void
  onPreview: (url: string) => void
}) {
  const [runs, setRuns] = useState<ReadonlyArray<WorkspaceRunState>>([])
  const [error, setError] = useState<string | null>(null)
  const commands = project?.workflow?.runs ?? []
  const lifecycle = session.workspaceLifecycle
  const displayed = [...commands, ...runs.filter(run => !commands.some(command => command.id === run.id))]

  useEffect(() => {
    let cancelled = false
    const refresh = () => void rpc.workspaceWorkflowListRuns(session.id).then((value) => {
      if (!cancelled) setRuns(value)
    }).catch(() => undefined)
    refresh()
    const timer = setInterval(refresh, 2_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [session.id])

  if (!lifecycle && commands.length === 0 && !session.workspacePorts && session.workspaceMode !== "worktree") return null

  const mutateSession = async (action: () => Promise<Session>) => {
    setError(null)
    try { onSession(await action()) } catch (cause) { setError(cause instanceof Error ? cause.message : "Workspace action failed.") }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2 text-xs" data-testid="workspace-workflow-bar">
      <WorkspaceCheckpointsView key={session.id} session={session} onSession={onSession} />
      {session.workspacePorts ? <>
        <span data-testid="workspace-port">Port {session.workspacePorts.primary}</span>
        <Button size="sm" variant="outline" onClick={async () => {
          setError(null)
          try { onPreview(await rpc.workspacePortsPreview(session.id)) }
          catch (cause) { setError(cause instanceof Error ? cause.message : "Preview is not ready. Retry after starting the server.") }
        }}>Open preview</Button>
        <Button size="sm" variant="outline" onClick={async () => {
          setError(null)
          try { const occupied = await rpc.workspacePortsCheck(session.id); if (occupied.length) setError(`Ports ${occupied.join(", ")} are assigned elsewhere or have listeners. If these are not your workspace servers, stop all workspace activity and reassign ports.`) }
          catch (cause) { setError(cause instanceof Error ? cause.message : "Could not check ports.") }
        }}>Check ports</Button>
        <Button size="sm" variant="outline" onClick={() => void mutateSession(() => rpc.workspacePortsReassign(session.id))}>Reassign ports</Button>
      </> : null}
      {lifecycle?.status === "setup-running" ? <span role="status" className="text-dim">Preparing workspace…</span> : null}
      {lifecycle?.status === "cleanup-failed" ? (
        <>
          <span role="alert" className="text-red">Cleanup failed: {lifecycle.error}</span>
          <Button size="sm" variant="danger" onClick={() => void mutateSession(() => rpc.sessionsArchive(session.id, "closed", true))}>Archive without cleanup</Button>
        </>
      ) : null}
      {lifecycle?.status === "setup-failed" ? (
        <>
          <span role="alert" className="text-red">Setup failed: {lifecycle.error}</span>
          <Button size="sm" onClick={() => void mutateSession(() => rpc.workspaceWorkflowRetrySetup(session.id))}>Retry setup</Button>
          <Button size="sm" variant="outline" onClick={() => void mutateSession(() => rpc.workspaceWorkflowSkipSetup(session.id))}>Skip setup</Button>
        </>
      ) : null}
      {readyForRuns(lifecycle) ? displayed.map((command) => {
        const state = runs.find((candidate) => candidate.id === command.id)
        return state?.status === "running" ? (
          <Button key={command.id} size="sm" variant="outline" onClick={async () => {
            setError(null)
            try { await rpc.workspaceWorkflowStopRun(session.id, command.id); setRuns(await rpc.workspaceWorkflowListRuns(session.id)) }
            catch (cause) { setError(cause instanceof Error ? cause.message : "Could not stop command.") }
          }}>Stop {state.label}</Button>
        ) : commands.some(configured => configured.id === command.id) ? (
          <Button key={command.id} size="sm" onClick={async () => {
            setError(null)
            try { const next = await rpc.workspaceWorkflowStartRun(session.id, command.id); setRuns((current) => [...current.filter((item) => item.id !== next.id), next]) }
            catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start command.") }
          }}>Run {command.label}</Button>
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
