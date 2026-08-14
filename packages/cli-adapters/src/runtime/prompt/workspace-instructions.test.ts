import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadWorkspaceInstructions } from "./workspace-instructions.js"

const roots: Array<string> = []

const temporary = async (prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("workspace instructions", () => {
  it("loads root-to-cwd files in deterministic AGENTS then CLAUDE order", async () => {
    const root = await temporary("jingler-instructions-")
    const nested = join(root, "packages", "app")
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "root agents")
    await writeFile(join(root, "CLAUDE.md"), "root claude")
    await writeFile(join(nested, "AGENTS.md"), "nested agents")
    const result = await loadWorkspaceInstructions({ root, cwd: nested })
    expect(result.sources.map((source) => source.path)).toEqual([
      "AGENTS.md", "CLAUDE.md", "packages/app/AGENTS.md"
    ])
  })

  it("bounds each file and the aggregate", async () => {
    const root = await temporary("jingler-instructions-")
    await writeFile(join(root, "AGENTS.md"), "a".repeat(20))
    await writeFile(join(root, "CLAUDE.md"), "c".repeat(20))
    const result = await loadWorkspaceInstructions({ root, maxFileBytes: 12, maxTotalBytes: 18 })
    expect(result.sources.map((source) => source.content.length)).toEqual([12, 6])
    expect(result.sources.every((source) => source.truncated)).toBe(true)
  })

  it("rejects an instruction symlink escaping the workspace", async () => {
    const root = await temporary("jingler-instructions-")
    const outside = await temporary("jingler-outside-")
    await writeFile(join(outside, "private.md"), "private")
    await symlink(join(outside, "private.md"), join(root, "AGENTS.md"))
    const result = await loadWorkspaceInstructions({ root })
    expect(result.sources).toEqual([])
    expect(result.skipped).toMatchObject([{ reason: "symlink escapes workspace" }])
  })

  it("rejects a cwd outside the workspace", async () => {
    const root = await temporary("jingler-instructions-")
    const outside = await temporary("jingler-outside-")
    await expect(loadWorkspaceInstructions({ root, cwd: outside })).rejects.toThrow("outside root")
  })
})
