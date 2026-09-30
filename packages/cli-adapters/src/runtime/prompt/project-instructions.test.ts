import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { projectInstructionsLayer } from "./project-instructions.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Pi project instructions", () => {
  it("loads workspace-root AGENTS.md before CLAUDE.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-project-instructions-"))
    roots.push(root)
    await writeFile(join(root, "AGENTS.md"), "Run focused tests.")
    await writeFile(join(root, "CLAUDE.md"), "Use the package scripts.")

    const layer = await projectInstructionsLayer(root)

    expect(layer).toMatchObject({
      id: "workspace.project-instructions",
      kind: "workspace",
      trust: "untrusted",
      required: false
    })
    expect(layer!.content).toContain("Run focused tests.")
    expect(layer!.content).toContain("Use the package scripts.")
    expect(layer!.content.indexOf("## AGENTS.md")).toBeLessThan(
      layer!.content.indexOf("## CLAUDE.md")
    )
  })

  it("ignores missing files and symlinks outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-project-instructions-"))
    const outside = await mkdtemp(join(tmpdir(), "jingler-project-instructions-outside-"))
    roots.push(root, outside)
    await writeFile(join(outside, "AGENTS.md"), "outside secret")
    await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"))
    await mkdir(join(root, "nested"))
    await writeFile(join(root, "nested", "CLAUDE.md"), "nested rule")

    expect(await projectInstructionsLayer(root)).toBeNull()
  })
})
