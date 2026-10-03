import { randomUUID } from "node:crypto"
import { RoutineDocument, RoutineInput, routineRunActive, type Routine, type RoutineRun } from "@jingler/core"
import { Schema } from "effect"
import { AtomicJsonFile } from "./runtime/persistence/atomic-json-file.js"

const empty = (): RoutineDocument => ({ version: 1, routines: [], runs: [] })
const trimHistory = (runs: ReadonlyArray<RoutineRun>) => runs.filter(routineRunActive).concat(runs.filter(run => !routineRunActive(run)).slice(-500))
const nextAfter = (routine: Routine, now: number) => routine.schedule.kind === "once" ? null
  : routine.schedule.at + (Math.floor((now - routine.schedule.at) / routine.schedule.everyMs) + 1) * routine.schedule.everyMs

/** One atomic document owns definitions, occurrence cursors and reserved session IDs. */
export class RoutineStore {
  readonly document: AtomicJsonFile<RoutineDocument>
  constructor(file: string) {
    this.document = new AtomicJsonFile({ file, decode: raw => {
      const value = Schema.decodeUnknownSync(RoutineDocument)(JSON.parse(raw))
      const ids = new Set<string>()
      for (const routine of value.routines) {
        if (ids.has(routine.id)) throw new Error("Duplicate routine identity")
        ids.add(routine.id)
        if (routine.nextAt !== null && (routine.nextAt < routine.schedule.at || (routine.schedule.kind === "once" ? routine.nextAt !== routine.schedule.at : (routine.nextAt - routine.schedule.at) % routine.schedule.everyMs !== 0))) throw new Error("Invalid occurrence cursor")
      }
      if (value.runs.filter(routineRunActive).length > 1 || new Set(value.runs.map(run => run.requestedSessionId)).size !== value.runs.length) throw new Error("Invalid routine run identities")
      return value
    }, fallback: empty })
  }
  read() { return this.document.read() }
  async save(id: string | undefined, input: RoutineInput, workflowDigest: string | null, now: number) {
    const decoded = Schema.decodeUnknownSync(RoutineInput)(input)
    if (![decoded.name, decoded.prompt, decoded.baseBranch].every(value => value.trim())) throw new Error("Name, prompt and base branch are required")
    await this.document.update(current => {
      const old = id === undefined ? undefined : current.routines.find(item => item.id === id)
      if (id !== undefined && old === undefined) throw new Error("Routine no longer exists")
      const routine: Routine = { ...decoded, id: id ?? randomUUID(), revision: randomUUID(), workflowDigest, createdAt: old?.createdAt ?? now, updatedAt: now, nextAt: decoded.schedule.at }
      return { ...current, routines: [...current.routines.filter(item => item.id !== routine.id), routine] }
    })
    return this.read()
  }
  async enable(id: string, enabled: boolean, now: number) {
    await this.document.update(current => {
      if (!current.routines.some(item => item.id === id)) throw new Error("Routine no longer exists")
      return { ...current, routines: current.routines.map(item => item.id === id ? { ...item, enabled, updatedAt: now, revision: randomUUID() } : item) }
    })
    return this.read()
  }
  async delete(id: string) {
    await this.document.update(current => ({ ...current, routines: current.routines.filter(item => item.id !== id) }))
    return this.read()
  }
  async claim(id: string, trigger: RoutineRun["trigger"], now: number, skipMissed = false): Promise<{ routine: Routine; run: RoutineRun } | null> {
    let claimed: { routine: Routine; run: RoutineRun } | null = null
    await this.document.update(current => {
      const routine = current.routines.find(item => item.id === id)
      if (!routine || (trigger === "scheduled" && (!routine.enabled || routine.nextAt === null || routine.nextAt > now))) return current
      const at = trigger === "manual" ? now : routine.nextAt!
      const missed = trigger === "scheduled" && (skipMissed || now - at > 5000)
      const overlap = current.runs.some(routineRunActive)
      const skippedCount = missed && routine.schedule.kind === "interval" ? Math.floor((now - at) / routine.schedule.everyMs) + 1 : 1
      const run: RoutineRun = { id: randomUUID(), routineId: id, routineName: routine.name, revision: routine.revision, trigger, occurrenceAt: at, requestedSessionId: `s_routine_${randomUUID().replaceAll("-", "")}`, sessionId: null, status: missed || overlap ? "skipped" : "claimed", message: missed ? "Missed while desktop was unavailable; no catch-up" : overlap ? "Another routine is active; overlap skipped" : "Occurrence reserved", createdAt: now, finishedAt: missed || overlap ? now : null, skippedCount }
      claimed = { routine, run }
      return { ...current, routines: current.routines.map(item => item.id === id && trigger === "scheduled" ? { ...item, nextAt: nextAfter(item, now) } : item), runs: trimHistory([...current.runs, run]) }
    })
    return claimed
  }
  async isCurrent(run: RoutineRun) {
    const current = await this.read()
    const routine = current.routines.find(item => item.id === run.routineId)
    return routine !== undefined && routine.revision === run.revision && (run.trigger === "manual" || routine.enabled) && current.runs.some(item => item.id === run.id && routineRunActive(item))
  }
  async link(run: RoutineRun, now: number) {
    await this.document.update(current => ({ ...current, runs: current.runs.map(item => item.id === run.id && routineRunActive(item) ? { ...item, sessionId: run.requestedSessionId, status: "running", message: "Workspace created", createdAt: item.createdAt ?? now } : item) }))
  }
  async finish(id: string, status: RoutineRun["status"], message: string, now: number) {
    await this.document.update(current => ({ ...current, runs: trimHistory(current.runs.map(item => item.id === id && routineRunActive(item) ? { ...item, status, message, finishedAt: now } : item)) }))
  }
  async reconcile(sessionExists: (id: string) => Promise<boolean>, now: number) {
    // Never redispatch: reconcile only the exact ID reserved before creation.
    const current = await this.read()
    const linked = new Set<string>()
    for (const run of current.runs.filter(routineRunActive)) if (await sessionExists(run.requestedSessionId)) linked.add(run.id)
    await this.document.update(value => ({ ...value, runs: value.runs.map(run => routineRunActive(run) ? { ...run, sessionId: linked.has(run.id) ? run.requestedSessionId : run.sessionId, status: "interrupted", message: "Desktop restarted; unfinished run was not replayed", finishedAt: now } : run) }))
  }
}
