import { useEffect, useState } from "react"
import type { Project, Session, WorkspaceRunState } from "@jingler/core"
import { rpc } from "./rpc-client.js"

export const readyForWorkflowRuns = (lifecycle: Session["workspaceLifecycle"]): boolean =>
  lifecycle === undefined || lifecycle.status === "ready" || lifecycle.status === "setup-skipped"

const hasWorkspaceContent = (session: Session, commandCount: number, runs: ReadonlyArray<WorkspaceRunState>, error: string | null): boolean => {
  const lifecycle = session.workspaceLifecycle
  const hasNotice = lifecycle?.status === "setup-running" || lifecycle?.status === "setup-failed" || lifecycle?.status === "cleanup-failed"
  const hasControls = readyForWorkflowRuns(lifecycle) && (commandCount > 0 || runs.some(run => run.status === "running"))
  return Boolean(hasNotice || lifecycle?.output || hasControls || runs.some(run => run.status === "failed") || error)
}

/**
 * The workspace setup/run lifecycle for a session — polled run state, the
 * configured commands, and the retry/skip/start/stop mutations. Shared by the
 * workflow bar above the conversation and the Workflow section inside Checks,
 * so both read the same live state rather than each polling independently.
 */
export function useWorkspaceWorkflow(session: Session, project: Project | undefined, onSession: (session: Session) => void) {
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

  const mutateSession = async (action: () => Promise<Session>) => {
    setError(null)
    try { onSession(await action()) } catch (cause) { setError(cause instanceof Error ? cause.message : "Workspace action failed.") }
  }

  const startRun = async (commandId: string) => {
    setError(null)
    try { const next = await rpc.workspaceWorkflowStartRun(session.id, commandId); setRuns((current) => [...current.filter((item) => item.id !== next.id), next]) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start command.") }
  }

  const stopRun = async (commandId: string) => {
    setError(null)
    try { await rpc.workspaceWorkflowStopRun(session.id, commandId); setRuns(await rpc.workspaceWorkflowListRuns(session.id)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not stop command.") }
  }

  return {
    runs,
    error,
    commands,
    lifecycle,
    displayed,
    hasContent: hasWorkspaceContent(session, commands.length, runs, error),
    retrySetup: () => void mutateSession(() => rpc.workspaceWorkflowRetrySetup(session.id)),
    skipSetup: () => void mutateSession(() => rpc.workspaceWorkflowSkipSetup(session.id)),
    archiveWithoutCleanup: () => void mutateSession(() => rpc.sessionsArchive(session.id, "closed", true)),
    startRun,
    stopRun
  }
}
