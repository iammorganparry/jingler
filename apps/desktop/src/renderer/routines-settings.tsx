import { Schema } from "effect"
import { piEndpointId, ReasoningSetting } from "@jingler/core"
import type { Project, ProviderCatalog, RoutineInput, Routine } from "@jingler/core"
import type { ActorRefFrom } from "xstate"
import { useMachine } from "@xstate/react"
import { rpc } from "./rpc-client.js"
import { routinesMachine } from "./routines-machine.js"
const api = { list: rpc.routinesList, save: rpc.routinesSave, enable: rpc.routinesEnable, delete: rpc.routinesDelete, runNow: rpc.routinesRunNow, cancel: rpc.routinesCancel }
const localDateTime = (time: number) => { const date = new Date(time); return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19) }
type RoutineModel = ProviderCatalog["connections"][number]["models"][number] & { connection: ProviderCatalog["connections"][number]["connection"] }
function routineFormInput(data: FormData, models: RoutineModel[], selected: Routine | undefined): RoutineInput | undefined {
      const model = models.find(item => `${item.connection.id}/${item.providerId}/${item.id}` === data.get("model"))
      if (!model) return undefined
      const at = selected && data.get("at") === localDateTime(selected.schedule.at) ? selected.schedule.at : new Date(String(data.get("at"))).getTime()
      const input: RoutineInput = { name: String(data.get("name")), prompt: String(data.get("prompt")), projectId: String(data.get("project")), baseBranch: String(data.get("branch")), runtimeId: "pi", endpointId: piEndpointId(model.connection.targetId, model.connection.id), connectionId: model.connection.id, providerId: model.providerId, modelId: model.id, reasoning: data.get("reasoning") === "default" ? null : Schema.decodeUnknownSync(ReasoningSetting)({ enabled: data.get("reasoning") !== "off", ...(data.get("reasoning") === "off" ? {} : { effort: data.get("reasoning") }) }), mode: "ask", schedule: data.get("schedule") === "interval" ? { kind: "interval", at, everyMs: Number(data.get("interval")) * 60000 } : { kind: "once", at }, enabled: data.get("enabled") === "on", approved: true, maxDurationMs: Number(data.get("duration")) * 60000 }
  return input
}
export function RoutinesSettings({ projects, catalog, onSession }: { projects: ReadonlyArray<Project>; catalog: ProviderCatalog | null; onSession(id: string): Promise<void> }) {
  const [state, send] = useMachine(routinesMachine, { input: { api: { ...api, open: onSession } } })
  const { document, editing, error } = state.context
  const selected = document.routines.find(item => item.id === editing)
  const models = (catalog?.connections ?? []).filter(entry => entry.connection.targetId === "desktop").flatMap(entry => entry.models.filter(model => model.selectable).map(model => ({ ...model, connection: entry.connection })))
  const busy = state.matches("working")
  return <section aria-label="Saved desktop routines" className="space-y-3 text-[var(--sb-fg)]">
    <h3>Saved desktop routines</h3>
    <p>Runs only while this desktop is open and signed in. Missed schedules and overlapping runs are skipped. One routine runs at a time; interactive agents remain independent.</p>
    <p>Every run uses a fresh checkpoint-safe worktree. Edit and inspect files only. File rename is unsupported in safe mode; no files are changed. Arbitrary shell, tests, builds, terminals, delegation, offload and external tools are unsupported. Saved model, reasoning and Ask permissions are used without escalation or fallback.</p>
    {error && <p role="alert">{error}<button type="button" onClick={() => send({ type: "REFRESH" })}>Retry</button></p>}
    <RoutineForm key={selected ? `${selected.id}/${selected.revision}` : "new"} {...{ projects, models, selected, editing, busy, send }} />
    {document.routines.map(routine => <div key={routine.id}>
      <strong>{routine.name}</strong><p>Next: {routine.enabled && routine.nextAt !== null ? new Date(routine.nextAt).toLocaleString() : "Not scheduled"}</p>
      <button disabled={busy} type="button" onClick={() => send({ type: "EDIT", id: routine.id })}>Edit {routine.name}</button>
      <button disabled={busy} type="button" onClick={() => send({ type: "ENABLE", id: routine.id, enabled: !routine.enabled })}>{routine.enabled ? "Disable" : "Enable"} {routine.name}</button>
      <button disabled={busy} type="button" onClick={() => send({ type: "RUN", id: routine.id })}>Run now {routine.name}</button>
      <button disabled={busy} type="button" onClick={() => send({ type: "DELETE", id: routine.id })}>Delete {routine.name}</button>
    </div>)}
    {document.health?.error && <p role="alert">{document.health.error}. {document.health.recovery}. <button type="button" onClick={() => send({ type: "REFRESH" })}>Refresh history and health</button></p>}
    <h4>Run history</h4>
    {document.runs.slice().sort((a, b) => b.createdAt - a.createdAt).map(run => <div key={run.id}><span>{run.routineName}: {run.status} — {run.message}</span>{run.sessionId && <button type="button" disabled={busy} onClick={() => send({ type: "OPEN", id: run.sessionId! })}>Open workspace {run.routineName}</button>}{(run.status === "running" || run.status === "claimed") && <button disabled={busy} type="button" onClick={() => send({ type: "CANCEL", id: run.id })}>Cancel {run.routineName}</button>}</div>)}
  </section>
}

function RoutineForm({ projects, models, selected, editing, busy, send }: { projects: ReadonlyArray<Project>; models: RoutineModel[]; selected: Routine | undefined; editing: string | undefined; busy: boolean; send: ActorRefFrom<typeof routinesMachine>["send"] }) {
  return <form aria-label="Save routine" onChange={event => { if (!(event.target instanceof HTMLInputElement && event.target.name === "approved")) { const consent = event.currentTarget.elements.namedItem("approved") as HTMLInputElement | null; if (consent) consent.checked = false; } }} onSubmit={event => {
      event.preventDefault()
      const input = routineFormInput(new FormData(event.currentTarget), models, selected)
      if (!input) return
      send({ type: "SAVE", id: editing, input })
    }} className="space-y-2">
      <label>Name<input name="name" required maxLength={120} defaultValue={selected?.name} /></label>
      <label>Local project<select name="project" required defaultValue={selected?.projectId}>{projects.filter(project => !project.environmentId).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>Base branch<input name="branch" required defaultValue={selected?.baseBranch ?? "main"} /></label>
      <label>Managed Pi model<select name="model" required defaultValue={selected ? `${selected.connectionId}/${selected.providerId}/${selected.modelId}` : undefined}>{models.map(model => <option key={`${model.connection.id}/${model.providerId}/${model.id}`} value={`${model.connection.id}/${model.providerId}/${model.id}`}>{model.connection.providerId} · {model.id}</option>)}</select></label>
      <label>Reasoning<select name="reasoning" defaultValue={selected?.reasoning ? (selected.reasoning.enabled ? selected.reasoning.effort ?? "medium" : "off") : "default"}><option value="default">Provider default</option><option value="off">Off</option>{["minimal", "low", "medium", "high", "xhigh", "max"].map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label><p>Permissions: Ask. No automatic escalation.</p>
      <label>Prompt<textarea name="prompt" required defaultValue={selected?.prompt} /></label>
      <label>Schedule<select name="schedule" defaultValue={selected?.schedule.kind ?? "once"}><option value="once">Once</option><option value="interval">Fixed interval</option></select></label>
      <label>First occurrence<input name="at" type="datetime-local" step={1} required defaultValue={localDateTime(selected?.schedule.at ?? Date.now() + 60000)} /></label>
      <label>Interval minutes<input name="interval" type="number" min={1} max={525600} defaultValue={selected?.schedule.kind === "interval" ? selected.schedule.everyMs / 60000 : 60} /></label>
      <label>Maximum run minutes<input name="duration" type="number" min={1} max={1440} defaultValue={selected ? selected.maxDurationMs / 60000 : 10} /></label>
      <label><input type="checkbox" name="enabled" defaultChecked={selected?.enabled ?? false} />Enable schedule</label>
      <label><input type="checkbox" name="approved" required />I approve these exact settings and the edit/inspect-only restrictions for Save and Run now.</label>
      <button disabled={busy} type="submit">Save routine</button>
      <button disabled={busy} type="button" onClick={() => send({ type: "EDIT" })}>New routine</button>
    </form>
}
