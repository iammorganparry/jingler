import { useEffect } from "react"
import { useMachine } from "@xstate/react"
import type { Session } from "@jingler/core"
import { Button, Dialog, DialogContent, DialogTitle, DialogBody } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { workspaceCheckpointsMachine } from "./workspace-checkpoints-machine.js"
const api = {
  setMode: rpc.workspaceCheckpointsSetMode, list: rpc.workspaceCheckpointsList,
  capture: rpc.workspaceCheckpointsCapture, preview: rpc.workspaceCheckpointsPreview,
  restore: rpc.workspaceCheckpointsRestore
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: UI maps mutually exclusive machine states to consent, preview and retry controls.
export function WorkspaceCheckpointsView({ session, onSession, onClosed, returnFocus }: { session: Session; onSession(session: Session): void; onClosed(): void; returnFocus: HTMLButtonElement | null }) {
  const [state, send] = useMachine(workspaceCheckpointsMachine, { input: { session, api, onSession } })
  useEffect(() => { send({ type: "OPEN" }) }, [send])
  const supported = session.workspaceMode === "worktree" && !session.environmentId && session.executionLocation !== "cloud" && !session.archived
  const cancel = () => { send({ type: "CANCEL" }); if (state.matches("ready")) onClosed() }
  return <Dialog open={!state.matches("closed")} onOpenChange={(open) => { if (!open) cancel() }}>
    <DialogContent hideClose aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus?.isConnected) returnFocus.focus() }}>
      <DialogTitle className="px-4 pt-4">Workspace checkpoints</DialogTitle>
      <DialogBody data-testid="workspace-checkpoints" className="space-y-2 text-xs">
      <p>Checkpoints cover the whole workspace and preserve staging. Restore requires all work to be idle. External editors cannot be locked; review the exact diff before confirming.</p>
      {!supported ? <p role="alert">Checkpoints require an isolated local workspace. Create a fresh managed Pi workspace.</p> : null}
      {state.context.session.checkpointExecutionHistory !== "clean" ? <p role="alert">Prior or unknown terminal execution prevents safe checkpoints. Create a fresh workspace.</p> : null}
      {state.matches("ready") ? <>
        <p>Checkpoint-safe mode: {state.context.session.checkpointSafeMode ? "On" : "Off"}</p>
        <Button size="sm" onClick={() => send({ type: state.context.session.checkpointSafeMode ? "DISABLE" : "ENABLE" })}>{state.context.session.checkpointSafeMode ? "Disable safe mode" : "Enable safe mode"}</Button>
        <Button size="sm" onClick={() => send({ type: "CAPTURE" })}>Capture checkpoint</Button>
        {state.context.items.map((item) => <div key={item.id}><span>{item.label} · {item.createdAt}{item.pinned ? " · pinned recovery backup" : ""}</span><Button size="sm" onClick={() => send({ type: "PREVIEW", id: item.id })}>Preview restore</Button></div>)}
      </> : null}
      {state.matches("consent") ? <>
        <p>Safe mode supports managed Pi structured file edits and read-only inspection only. File rename is unsupported in safe mode; no files are changed. Shell commands, builds, tests, interactive terminals, delegation and offload are blocked. Every turn captures first; failed capture blocks the turn. Models and permissions are never changed automatically.</p>
        <Button size="sm" onClick={() => send({ type: "CONFIRM" })}>Agree and enable</Button>
      </> : null}
      {state.matches("confirming") && state.context.preview ? <>
        <p>Workspace file changes</p>
        <ul aria-label="Workspace file changes">{state.context.preview.operations.map((op) => <li key={op.path}>{op.action}: {op.path}</li>)}</ul>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{state.context.preview.diff}</pre>
        <p>Staging changes</p>
        <ul aria-label="Staging changes">{state.context.preview.indexOperations.map((op) => <li key={op.path}>{op.action}: {op.path}</li>)}</ul>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{state.context.preview.indexDiff}</pre>
        <p>Stop external editors and file watchers before confirming. A pinned safety backup is created before restore. Restore checks are best-effort and cannot lock external writers; late changes may not be in the backup. Later untracked and ignored files are preserved.</p>
        <Button size="sm" variant="danger" onClick={() => send({ type: "CONFIRM" })}>Confirm restore</Button>
      </> : null}
      {state.matches("working") ? <p role="status">Working…</p> : null}
      {state.matches("failed") ? <><p role="alert">{state.context.error}</p><Button size="sm" onClick={() => send({ type: "RETRY" })}>Retry</Button></> : null}
      <Button size="sm" variant="outline" disabled={state.matches("working")} onClick={cancel}>Cancel</Button>
      </DialogBody>
    </DialogContent>
  </Dialog>
}
