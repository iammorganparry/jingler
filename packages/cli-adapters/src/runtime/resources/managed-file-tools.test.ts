import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { ToolRegistry } from "../tools/tool-registry.js"
import { makeAgentResourceService } from "./agent-resource-service.js"
import { registerManagedFileTools } from "./managed-file-tools.js"
import { detectAgentResources } from "./resource-detector.js"

const roots: string[] = []
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-managed-file-tools-"))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe("managed file tools", () => {
  it("advertises metadata and loads current instructions only when invoked", async () => {
    const home = await temporary()
    const managedRoot = await temporary()
    const sourceDir = join(home, ".agents", "skills", "release")
    await mkdir(sourceDir, { recursive: true })
    const description = "Release safely ".repeat(20)
    await writeFile(join(sourceDir, "SKILL.md"), `name: release\ndescription: ${description}\nOriginal`)
    const candidate = (await Effect.runPromise(detectAgentResources({ homeDir: home, worktreePath: null }))).candidates[0]!
    const service = await Effect.runPromise(makeAgentResourceService({ managedRoot }))
    await Effect.runPromise(service.importResources([candidate], { kind: "portable", allowedTargets: [] }))
    const resources = await Effect.runPromise(service.enabledForTarget("desktop"))
    const registry = new ToolRegistry()
    registerManagedFileTools(registry, service, resources)
    await writeFile(join(managedRoot, "skills", "release", "SKILL.md"), "Updated at invocation")

    expect(registry.capabilitiesFor("conversation", "ask").map(({ id }) => id)).toEqual([
      "jingler_list_resources",
      "jingler_load_resource"
    ])
    const listed = await Effect.runPromise(registry.execute({
      id: "jingler_list_resources",
      arguments: { query: "release" },
      role: "conversation",
      mode: "ask"
    }))
    expect(listed).toMatchObject({
      status: "success",
      value: {
        total: 1,
        truncated: false,
        resources: [{ id: "release", kind: "skill", description: description.slice(0, 160) }]
      }
    })
    const loaded = await Effect.runPromise(registry.execute({
      id: "jingler_load_resource",
      arguments: { id: "release" },
      role: "conversation",
      mode: "ask"
    }))
    expect(loaded).toMatchObject({
      status: "success",
      value: { instructions: "Updated at invocation", truncated: false }
    })
  })
})
