import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { FileChangeTracker } from "./file-change-tracker.js"

const roots: Array<string> = []
const trackers: Array<FileChangeTracker> = []
const git = (cwd: string, args: ReadonlyArray<string>): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}
const makeTracker = (
  input: ConstructorParameters<typeof FileChangeTracker>[0]
): FileChangeTracker => {
  const tracker = new FileChangeTracker(input)
  trackers.push(tracker)
  return tracker
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
  await Promise.all(trackers.splice(0).map((tracker) => Effect.runPromise(tracker.dispose())))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("FileChangeTracker", () => {
  it("derives create modify delete rename binary and no-newline evidence from workspace state", async () => {
    const root = await repository()
    const tracker = makeTracker({ artifactDir: join(root, ".artifacts"), sessionId: "session-1" })
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
    const tracker = makeTracker({ artifactDir: join(root, ".artifacts"), sessionId: "session-1", maxArtifactBytes: 128 })
    const before = await Effect.runPromise(tracker.capture(root))
    await writeFile(join(root, "edit.ts"), `${"line\n".repeat(100)}`)
    const result = await Effect.runPromise(tracker.compare(before, root))
    const id = result.changes[0]?.patchArtifactId
    expect(id).toBeTruthy()
    expect(result.changes[0]).toMatchObject({ added: 100, removed: 1 })
    expect((await Effect.runPromise(tracker.readArtifact(id!))).length).toBeLessThanOrEqual(128)
    expect(JSON.stringify(result)).not.toContain("diff --git")
  })

  it("reconciles binaries whose encoded patch would exceed the git output buffer", async () => {
    const root = await repository()
    const tracker = makeTracker({ artifactDir: join(root, ".artifacts"), sessionId: "session-1" })
    const before = await Effect.runPromise(tracker.capture(root))
    await writeFile(join(root, "large.bin"), randomBytes(28 * 1024 * 1024))

    const result = await Effect.runPromise(tracker.compare(before, root))

    expect(result.changes).toContainEqual(expect.objectContaining({
      status: "A",
      path: "large.bin",
      binary: true,
      added: 0,
      removed: 0,
      patchArtifactId: null
    }))
  }, 30_000)

  it("reuses one stat-cached shadow index across captures and disposes it", async () => {
    const root = await repository()
    const shadowRoot = await mkdtemp(join(tmpdir(), "jingler-shadow-root-"))
    roots.push(shadowRoot)
    const tracker = makeTracker({
      artifactDir: join(root, ".artifacts"),
      sessionId: "session-1",
      shadowIndexRoot: shadowRoot
    })

    const before = await Effect.runPromise(tracker.capture(root))
    const [shadowDirectory] = await readdir(shadowRoot)
    expect(shadowDirectory).toBeTruthy()
    const index = join(shadowRoot, shadowDirectory!, "index")
    const debug = execFileSync("git", ["ls-files", "--debug"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: index }
    })
    expect(debug).toContain("size: 4")

    await writeFile(join(root, "edit.ts"), "changed\n")
    const after = await Effect.runPromise(tracker.capture(root))
    expect(after.tree).not.toBe(before.tree)
    expect(await readdir(shadowRoot)).toEqual([shadowDirectory])

    await Effect.runPromise(tracker.dispose())
    expect(await readdir(shadowRoot)).toEqual([])
  })
})
