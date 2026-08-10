import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { FileChangeTracker } from "./file-change-tracker.js"

const roots: Array<string> = []
const git = (cwd: string, args: ReadonlyArray<string>): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "jingler-file-changes-"))
  roots.push(root)
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "fixture@example.invalid"])
  git(root, ["config", "user.name", "Jingler Fixture"])
  await writeFile(join(root, "edit.ts"), "old\n")
  await writeFile(join(root, "delete.ts"), "delete\n")
  await writeFile(join(root, "rename.ts"), "rename\n")
  await writeFile(join(root, "no-newline.ts"), "before\n")
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "fixture"])
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("FileChangeTracker", () => {
  it("derives create modify delete rename binary and no-newline evidence from workspace state", async () => {
    const root = await repository()
    const tracker = new FileChangeTracker({ artifactDir: join(root, ".artifacts"), sessionId: "session-1" })
    const before = await Effect.runPromise(tracker.capture(root))
    await writeFile(join(root, "new.ts"), "new\n")
    await writeFile(join(root, "edit.ts"), "changed\n")
    await rm(join(root, "delete.ts"))
    await mkdir(join(root, "moved"))
    await rename(join(root, "rename.ts"), join(root, "moved", "rename.ts"))
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(root, "no-newline.ts"), "after")

    const result = await Effect.runPromise(tracker.compare(before, root, "call-1"))
    expect(result.changes.map(({ status, path, oldPath }) => ({ status, path, oldPath }))).toEqual(expect.arrayContaining([
      { status: "A", path: "new.ts", oldPath: null },
      { status: "M", path: "edit.ts", oldPath: null },
      { status: "D", path: "delete.ts", oldPath: null },
      { status: "R", path: "moved/rename.ts", oldPath: "rename.ts" }
    ]))
    expect(result.changes.find((change) => change.path === "binary.bin")).toMatchObject({ binary: true, patchArtifactId: null })
    expect(result.changes.find((change) => change.path === "no-newline.ts")?.noNewlineAtEnd).toBe(true)
  })

  it("stores bounded text patches outside normalized records", async () => {
    const root = await repository()
    const tracker = new FileChangeTracker({ artifactDir: join(root, ".artifacts"), sessionId: "session-1", maxArtifactBytes: 128 })
    const before = await Effect.runPromise(tracker.capture(root))
    await writeFile(join(root, "edit.ts"), `${"line\n".repeat(100)}`)
    const result = await Effect.runPromise(tracker.compare(before, root))
    const id = result.changes[0]?.patchArtifactId
    expect(id).toBeTruthy()
    expect((await Effect.runPromise(tracker.readArtifact(id!))).length).toBeLessThanOrEqual(128)
    expect(JSON.stringify(result)).not.toContain("diff --git")
  })
})
