import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RoutineInput } from "@jingler/core"
import { Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RoutineStore } from "./routine-store.js"
const input = Schema.decodeUnknownSync(RoutineInput)({ name: "Inspect", projectId: "local", prompt: "Inspect files", baseBranch: "main", runtimeId: "pi", endpointId: "pi:desktop:test", connectionId: "test", providerId: "test", modelId: "model", mode: "ask", reasoning: null, enabled: true, approved: true, schedule: { kind: "once", at: 1000 }, maxDurationMs: 1000 })
describe("RoutineStore durable occurrences", () => {
  let root: string; let store: RoutineStore
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "routine-store-")); store = new RoutineStore(join(root, "routines.json")) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  it("reserves identity before creation and never replays a completed once after edit", async () => {
    const saved = await store.save(undefined, input, null, 0)
    const id = saved.routines[0]!.id
    const claim = await store.claim(id, "scheduled", 1000)
    expect(claim!.run.sessionId).toBeNull()
    expect((await new RoutineStore(join(root, "routines.json")).read()).runs[0]!.requestedSessionId).toBe(claim!.run.requestedSessionId)
    await store.finish(claim!.run.id, "succeeded", "Done", 1001)
    await store.save(id, { ...input, name: "Renamed" }, null, 1002)
    expect((await store.read()).routines[0]!.nextAt).toBeNull()
    expect(await store.claim(id, "scheduled", 1003)).toBeNull()
  })
  it("preserves interval cursor on edit, skips missed time and overlap globally", async () => {
    const interval = { ...input, schedule: { kind: "interval" as const, at: 1000, everyMs: 1000 } }
    const id = (await store.save(undefined, interval, null, 0)).routines[0]!.id
    const missed = await store.claim(id, "scheduled", 9000, true)
    expect(missed!.run.status).toBe("skipped"); expect(missed!.run.skippedCount).toBe(9)
    await store.save(id, { ...interval, name: "Renamed" }, null, 9001)
    expect((await store.read()).routines[0]!.nextAt).toBe(10000)
    const claim = await store.claim(id, "manual", 9002)
    expect(claim!.run.status).toBe("claimed")
    expect((await store.claim(id, "manual", 9003))!.run.status).toBe("skipped")
    await store.enable(id, false, 9004)
    expect(await store.isCurrent(claim!.run)).toBe(false)
  })
  it("reconciles claimed runs without redispatch and protects prompt history", async () => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id
    const claim = await store.claim(id, "manual", 500)
    await store.reconcile(async reserved => reserved === claim!.run.requestedSessionId, 800)
    const doc = await store.read()
    expect(doc.runs[0]!.status).toBe("interrupted")
    expect(doc.runs[0]!.sessionId).toBe(claim!.run.requestedSessionId)
    expect((await stat(join(root, "routines.json"))).mode & 0o777).toBe(0o600)
  })
  it.each([true, false])("recovers late creation association after failed teardown only when exact ownership is verified: %s", async matches => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id
    const claim = (await store.claim(id, "scheduled", 1000))!
    await store.finish(claim.run.id, "failed", "Preparation remains unresolved", 1001)
    const restarted = new RoutineStore(join(root, "routines.json"))
    await restarted.reconcile(async reserved => matches && reserved === claim.run.requestedSessionId, 2000)
    expect((await restarted.read()).runs[0]).toMatchObject({
      status: "failed", message: "Preparation remains unresolved", finishedAt: 1001,
      sessionId: matches ? claim.run.requestedSessionId : null
    })
    expect(await restarted.claim(id, "scheduled", 2001)).toBeNull()
  })
  it("fails closed on corrupt storage and refuses to replace it", async () => {
    const file = join(root, "routines.json")
    await writeFile(file, "{corrupt")
    await expect(store.read()).rejects.toThrow()
    await expect(store.save(undefined, input, null, 0)).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe("{corrupt")
  })
  it("allows the five-second timer grace and skips later occurrences without catch-up", async () => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id
    const within = (await store.claim(id, "scheduled", 6000))!
    expect(within.run.status).toBe("claimed")
    await store.finish(within.run.id, "succeeded", "Done", 6000)
    const other = (await store.save(undefined, { ...input, name: "Late" }, null, 0)).routines.find(routine => routine.id !== id)!
    const late = (await store.claim(other.id, "scheduled", 6001))!
    expect(late.run.status).toBe("skipped")
    expect((await store.read()).routines.find(routine => routine.id === other.id)!.nextAt).toBeNull()
  })

})
