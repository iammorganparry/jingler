import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedResourceId } from "@jingler/core"
import { Effect, Schema, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { detectAgentResources } from "./resource-detector.js"
import { makeAgentResourceService } from "./agent-resource-service.js"

const roots: string[] = []
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-managed-resources-"))
  roots.push(root)
  return root
}
const id = (value: string) => Schema.decodeUnknownSync(ManagedResourceId)(value)

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const detected = async (home: string) =>
  Effect.runPromise(detectAgentResources({ homeDir: home, worktreePath: null }))

describe("AgentResourceService", () => {
  it("imports files into managed storage and resolves duplicate ids deterministically", async () => {
    const home = await temporary()
    const managedRoot = await temporary()
    const skill = join(home, ".claude", "skills", "deploy")
    const prompts = join(home, ".claude", "commands")
    await mkdir(skill, { recursive: true })
    await mkdir(prompts, { recursive: true })
    await writeFile(join(skill, "SKILL.md"), "name: deploy\ndescription: Ship safely\n")
    await writeFile(join(prompts, "deploy.md"), "Review deployment")
    const candidates = (await detected(home)).candidates.filter((candidate) => candidate.kind !== "mcp")
    const service = await Effect.runPromise(makeAgentResourceService({ managedRoot }))

    const result = await Effect.runPromise(service.importResources(candidates, {
      kind: "portable",
      allowedTargets: []
    }))

    expect(result.imported).toEqual([id("deploy"), id("deploy-2")])
    const catalog = await Effect.runPromise(service.list)
    expect(catalog).toHaveLength(2)
    expect(await readFile(await Effect.runPromise(service.reveal(id("deploy"))), "utf8")).toContain("Ship safely")
    expect(await readFile(await Effect.runPromise(service.reveal(id("deploy-2"))), "utf8")).toBe("Review deployment")
  })

  it("enables, filters, watches, and removes resources without restart", async () => {
    const home = await temporary()
    const managedRoot = await temporary()
    const prompts = join(home, ".pi", "agent", "prompts")
    await mkdir(prompts, { recursive: true })
    await writeFile(join(prompts, "review.md"), "Review")
    const candidate = (await detected(home)).candidates[0]!
    const service = await Effect.runPromise(makeAgentResourceService({ managedRoot }))
    const updates = Effect.runPromise(Stream.runCollect(Stream.take(service.watch(), 2)))

    await Effect.runPromise(service.importResources([candidate], {
      kind: "portable",
      allowedTargets: ["desktop"]
    }))
    const observed = [...await updates]
    expect(observed.map((catalog) => catalog.length)).toEqual([0, 1])
    expect(await Effect.runPromise(service.enabledForTarget("desktop"))).toHaveLength(1)
    expect(await Effect.runPromise(service.enabledForTarget("remote"))).toHaveLength(0)

    await Effect.runPromise(service.setEnabled(id("review"), false))
    expect(await Effect.runPromise(service.enabledForTarget("desktop"))).toHaveLength(0)
    const managedPath = await Effect.runPromise(service.reveal(id("review")))
    await Effect.runPromise(service.remove(id("review")))
    await expect(readFile(managedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(await Effect.runPromise(service.list)).toEqual([])
  })

  it("refuses to remove a catalog path that is outside managed storage", async () => {
    const managedRoot = await temporary()
    const outside = join(await temporary(), "keep.md")
    await writeFile(outside, "keep")
    await writeFile(join(managedRoot, "catalog.json"), JSON.stringify([{
      id: "escape",
      kind: "prompt",
      name: "Escape",
      description: "Invalid persisted path",
      enabled: true,
      trust: "operator-approved",
      scope: { kind: "portable", allowedTargets: [] },
      managedPath: outside,
      byteLength: 4,
      provenance: {
        origin: "jingler",
        sourceRoot: managedRoot,
        sourcePath: outside,
        importedAt: new Date(0).toISOString()
      }
    }]))
    const service = await Effect.runPromise(makeAgentResourceService({ managedRoot }))

    const result = await Effect.runPromise(Effect.either(service.remove(id("escape"))))
    expect(result).toMatchObject({ _tag: "Left", left: {
      _tag: "AgentResourceError",
      operation: "reveal"
    } })
    expect(await readFile(outside, "utf8")).toBe("keep")
  })
})
