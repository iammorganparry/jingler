import { mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, JSONSchema, Schema } from "effect"
import { ProjectConfig } from "@jingler/core"
import { afterEach, beforeEach, expect, it } from "vitest"
import { ProjectService } from "./projects.js"
import { initGitRepo, mkTemp, runExit, withTempRoot } from "./test-support.js"
import { PROJECT_CONFIG_MAX_BYTES } from "./project-config.js"

const config = { version: 1, workflow: { setup: "pnpm install", runs: [{ id: "dev", label: "Dev", command: "pnpm dev" }], copyFiles: [".env.local"] }, routines: [{ id: "inspect", name: "Inspect", prompt: "Inspect README", baseBranch: "main", schedule: { kind: "interval", at: 1800000000000, everyMs: 60000 }, reasoning: null, maxDurationMs: 60000 }] }
let temp: ReturnType<typeof withTempRoot>
let repos: ReturnType<typeof mkTemp>
let projectId: string
let repo: string
beforeEach(async () => {
  temp = withTempRoot(); repos = mkTemp("jingler-config-")
  repo = initGitRepo(join(repos.dir, "repo"))
  mkdirSync(join(repo, ".jingler"))
  const result = await runExit(ProjectService.register({ path: repo }).pipe(Effect.provide(ProjectService.Default)), temp.layer)
  if (result._tag !== "Success") throw new Error("registration failed")
  projectId = result.value.id
})
afterEach(() => { temp.cleanup(); repos.cleanup() })
const read = (id = projectId) => runExit(ProjectService.readConfig(id).pipe(Effect.provide(ProjectService.Default)), temp.layer)
it("loads both review drafts without writing machine-local records", async () => {
  writeFileSync(join(repo, ".jingler/project.json"), JSON.stringify(config))
  const before = readFileSync(join(temp.root, "projects.json"), "utf8")
  expect(await read()).toMatchObject({ _tag: "Success", value: config })
  expect(readFileSync(join(temp.root, "projects.json"), "utf8")).toBe(before)
})
it.each([
  { ...config, version: 2 },
  ...["id", "name", "prompt", "baseBranch"].map(field => ({ ...config, routines: [{ ...config.routines[0], [field]: "   " }] })),
  { ...config, ports: {} },
  { ...config, connectionId: "secret" },
  { ...config, workflow: { ...config.workflow, approvedDigest: "forged" } },
  { ...config, workflow: { ...config.workflow, runs: [{ ...config.workflow.runs[0], credentials: "secret" }] } },
  { ...config, routines: [{ ...config.routines[0], approved: true }] },
  { ...config, routines: [{ ...config.routines[0], runtimeId: "pi" }] },
  { ...config, routines: [{ ...config.routines[0], reasoning: { enabled: true, secret: "private" } }] },
  { ...config, routines: [{ ...config.routines[0], schedule: { kind: "once", at: 0, token: "private" } }] },
  { ...config, routines: [config.routines[0], config.routines[0]] },
  { ...config, workflow: { ...config.workflow, copyFiles: ["../secret"] } },
  { ...config, workflow: { ...config.workflow, copyFiles: ["C:/secret"] } },
  { ...config, workflow: { ...config.workflow, copyFiles: ["dir\\secret"] } },
  { ...config, workflow: { ...config.workflow, copyFiles: [".git/config"] } },
])("rejects unsupported, excess or unsafe schema input %#", async (value) => {
  writeFileSync(join(repo, ".jingler/project.json"), JSON.stringify(value))
  const result = await read()
  expect(result._tag).toBe("Failure")
  expect(JSON.stringify(result)).not.toContain("private")
})
it("rejects malformed, missing, oversized and unregistered config", async () => {
  expect((await read())._tag).toBe("Failure")
  expect((await read("../../repo"))._tag).toBe("Failure")
  writeFileSync(join(repo, ".jingler/project.json"), "{malformed-private")
  const malformed = await read()
  expect(malformed._tag).toBe("Failure")
  expect(JSON.stringify(malformed)).not.toContain("malformed-private")
  writeFileSync(join(repo, ".jingler/project.json"), " ".repeat(PROJECT_CONFIG_MAX_BYTES + 1))
  expect((await read())._tag).toBe("Failure")
})
it("rejects remote registrations and outside file symlinks", async () => {
  const remote = await runExit(ProjectService.register({ path: repo, environmentId: "remote" }).pipe(Effect.provide(ProjectService.Default)), temp.layer)
  if (remote._tag !== "Success") throw new Error("remote registration failed")
  expect((await read(remote.value.id))._tag).toBe("Failure")
  const outside = join(repos.dir, "outside.json")
  writeFileSync(outside, JSON.stringify(config))
  symlinkSync(outside, join(repo, ".jingler/project.json"))
  expect((await read())._tag).toBe("Failure")
})
it("requires the strict decoder recursively, including optional sections", () => {
  const decode = Schema.decodeUnknownSync(ProjectConfig, { onExcessProperty: "error" })
  expect(decode({ version: 1 })).toEqual({ version: 1 })
  expect(() => decode({ version: 1, endpointId: "local" })).toThrow()
})
it("rejects symlinked config directories and nonregular config files", async () => {
  const otherRepo = initGitRepo(join(repos.dir, "other"))
  const registered = await runExit(ProjectService.register({ path: otherRepo }).pipe(Effect.provide(ProjectService.Default)), temp.layer)
  if (registered._tag !== "Success") throw new Error("registration failed")
  symlinkSync(join(repo, ".jingler"), join(otherRepo, ".jingler"))
  writeFileSync(join(repo, ".jingler/project.json"), JSON.stringify(config))
  expect((await read(registered.value.id))._tag).toBe("Failure")
  const nonregularRepo = initGitRepo(join(repos.dir, "nonregular"))
  const nonregular = await runExit(ProjectService.register({ path: nonregularRepo }).pipe(Effect.provide(ProjectService.Default)), temp.layer)
  if (nonregular._tag !== "Success") throw new Error("registration failed")
  mkdirSync(join(nonregularRepo, ".jingler/project.json"), { recursive: true })
  expect((await read(nonregular.value.id))._tag).toBe("Failure")
})
it("decodes the documented sample with the default strict schema and rejects nested excess keys", () => {
  const sample = JSON.parse(readFileSync(new URL("../../../docs/project-config.example.json", import.meta.url), "utf8"))
  expect(Schema.decodeUnknownSync(ProjectConfig)(sample)).toMatchObject({ version: 1 })
  expect(() => Schema.decodeUnknownSync(ProjectConfig)({ ...config, workflow: { ...config.workflow, credentials: "secret" } })).toThrow()
})

it("keeps the published schema identical to the code-owned portable contract", () => {
  const published = JSON.parse(readFileSync(new URL("../../../docs/project-config.schema.json", import.meta.url), "utf8"))
  expect(published).toEqual(JSONSchema.make(ProjectConfig))
})

it("loads a trusted canonical project root through a symlink alias", async () => {
  const { readProjectConfig } = await import("./project-config.js")
  const alias = join(repos.dir, "alias")
  symlinkSync(repo, alias)
  writeFileSync(join(repo, ".jingler/project.json"), JSON.stringify(config))
  expect(await Effect.runPromise(readProjectConfig({ path: alias, imported: true } as import("@jingler/core").Project))).toEqual(config)
})
