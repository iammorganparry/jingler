import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { RoutineInput } from "@jingler/core"
import { afterEach, beforeEach, expect, it } from "vitest"
import { ProjectService } from "./projects.js"
import { normalizeWorkflow, workflowDigest } from "./project-workflow.js"
import { RoutineStore } from "./routine-store.js"
import { runExit, withTempRoot } from "./test-support.js"

const draft = { setup: "echo setup", runs: [], copyFiles: [] }
const ports = { primary: 3000, extras: [{ name: "API", start: 4000 }], previewUrl: "http://localhost:{port}" }
const oldDigest = createHash("sha256").update(JSON.stringify({ ports, ...draft })).digest("hex")
const input = Schema.decodeUnknownSync(RoutineInput)({ name: "Inspect", projectId: "local", prompt: "Inspect files", baseBranch: "main", runtimeId: "pi", endpointId: "pi:desktop:test", connectionId: "test", providerId: "test", modelId: "model", mode: "ask", reasoning: null, enabled: true, approved: true, schedule: { kind: "once", at: 1000 }, maxDurationMs: 1000 })
let temp: ReturnType<typeof withTempRoot>
let store: RoutineStore
const project = (workflow: unknown) => ({ id: "local", name: "Local", path: "/repos/local", availability: "missing", imported: true, createdAt: "now", updatedAt: "now", workflow })
const start = () => runExit(ProjectService.pipe(Effect.provide(ProjectService.Default)), temp.layer)
beforeEach(() => { temp = withTempRoot(); mkdirSync(temp.root, { recursive: true }); store = new RoutineStore(join(temp.root, "routines.json")) })
afterEach(() => temp.cleanup())
it("persists only exact verified bindings before project writers; restart preserves once cursor and history", async () => {
  await store.save(undefined, input, oldDigest, 0)
  await store.save(undefined, input, oldDigest, 0)
  await store.save(undefined, input, "unrelated", 0)
  await store.save(undefined, { ...input, projectId: "other" }, oldDigest, 0)
  const before = await store.read()
  const claimed = (await store.claim(before.routines[0]!.id, "scheduled", 1000))!
  await store.finish(claimed.run.id, "succeeded", "Done", 1001)
  const consumed = await store.read()
  writeFileSync(join(temp.root, "projects.json"), JSON.stringify([project({ ...draft, ports, approvedDigest: oldDigest })]))
  const startup = await start()
  expect(startup._tag).toBe("Success")
  if (startup._tag !== "Success") throw new Error("startup failed")
  const migrated = await startup.value.routineStore.read()
  expect(migrated).toEqual({ ...consumed, routines: consumed.routines.map((routine) => routine.projectId === "local" && routine.workflowDigest === oldDigest ? { ...routine, workflowDigest: workflowDigest(draft) } : routine) })
  // A later project write drops ports. The routine binding is already durable.
  await runExit(startup.value.setWorkflow("local", draft, true), temp.layer)
  expect(readFileSync(join(temp.root, "projects.json"), "utf8")).not.toContain('"ports"')
  const restarted = await start()
  expect(restarted._tag).toBe("Success")
  if (restarted._tag !== "Success") throw new Error("restart failed")
  expect(await restarted.value.routineStore.read()).toEqual(migrated)
  expect(await restarted.value.routineStore.claim(consumed.routines[0]!.id, "scheduled", 2000)).toBeNull()
  const pending = await restarted.value.routineStore.claim(consumed.routines[1]!.id, "scheduled", 1000)
  expect(pending?.routine.workflowDigest).toBe(workflowDigest(draft))
  expect(pending?.run.status).toBe("claimed")
})
it.each([
  { ...draft, ports },
  { ...draft, ports, approvedDigest: "mismatch" },
  { ...draft, setup: "modified", ports, approvedDigest: oldDigest },
  { ...draft, ports: { ...ports, primary: 4001 }, approvedDigest: oldDigest },
  normalizeWorkflow(draft, true),
])("never blesses unapproved, modified or already portless payload %#", async workflow => {
  await store.save(undefined, input, oldDigest, 0)
  const before = await store.read()
  writeFileSync(join(temp.root, "projects.json"), JSON.stringify([project(workflow)]))
  expect((await start())._tag).toBe("Success")
  expect(await store.read()).toEqual(before)
})
it("fails startup on routine persistence failure without rewriting proof or consuming a one-shot", async () => {
  const raw = JSON.stringify([project({ ...draft, ports, approvedDigest: oldDigest })])
  writeFileSync(join(temp.root, "projects.json"), raw)
  writeFileSync(join(temp.root, "routines.json"), "{corrupt")
  expect((await start())._tag).toBe("Failure")
  expect(readFileSync(join(temp.root, "projects.json"), "utf8")).toBe(raw)
  expect(readFileSync(join(temp.root, "routines.json"), "utf8")).toBe("{corrupt")
})

it("ignores invalid full project payloads without updating any routine", async () => {
  await store.save(undefined, input, oldDigest, 0)
  const before = await store.read()
  const raw = JSON.stringify([project({ ...draft, runs: "invalid", ports, approvedDigest: oldDigest })])
  writeFileSync(join(temp.root, "projects.json"), raw)
  expect((await start())._tag).toBe("Success")
  expect(await store.read()).toEqual(before)
  expect(readFileSync(join(temp.root, "projects.json"), "utf8")).toBe(raw)
})

it("never trusts a matching digest over malformed removed fields", async () => {
  const malformed = { ...draft, ports: { primary: "invalid", extras: [] } }
  const digest = createHash("sha256").update(JSON.stringify({ ports: malformed.ports, ...draft })).digest("hex")
  await store.save(undefined, input, digest, 0)
  const before = await store.read()
  writeFileSync(join(temp.root, "projects.json"), JSON.stringify([project({ ...malformed, approvedDigest: digest })]))
  expect((await start())._tag).toBe("Success")
  expect(await store.read()).toEqual(before)
  const loaded = await runExit(ProjectService.get("local").pipe(Effect.provide(ProjectService.Default)), temp.layer)
  expect(loaded).toMatchObject({ _tag: "Success", value: { workflow: draft } })
  if (loaded._tag === "Success") expect(loaded.value.workflow?.approvedDigest).toBeUndefined()
})
