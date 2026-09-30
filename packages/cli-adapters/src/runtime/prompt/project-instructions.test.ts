import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { projectInstructionsLayer } from "./project-instructions.js"

const execFileAsync = promisify(execFile)
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

  it("ignores directories and symlinks instead of reading or blocking on them", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-project-instructions-"))
    const outside = await mkdtemp(join(tmpdir(), "jingler-project-instructions-outside-"))
    roots.push(root, outside)
    await mkdir(join(root, "AGENTS.md"))
    await writeFile(join(outside, "CLAUDE.md"), "outside secret")
    await symlink(join(outside, "CLAUDE.md"), join(root, "CLAUDE.md"))

    expect(await projectInstructionsLayer(root)).toBeNull()
  })

  it.runIf(process.platform !== "win32")(
    "ignores a FIFO without waiting for a writer",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "jingler-project-instructions-"))
      roots.push(root)
      await execFileAsync("mkfifo", [join(root, "AGENTS.md")])

      expect(await projectInstructionsLayer(root)).toBeNull()
    },
    1_000
  )

  it("marks oversized content and keeps a valid UTF-8 prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-project-instructions-"))
    roots.push(root)
    await writeFile(join(root, "AGENTS.md"), `${"a".repeat(32 * 1024 - 1)}😀tail`)

    const content = (await projectInstructionsLayer(root))!.content

    expect(content).toContain("[TRUNCATED: AGENTS.md exceeds 32768 bytes]")
    expect(content).not.toContain("�")
    expect(content).not.toContain("😀")
  })
})
