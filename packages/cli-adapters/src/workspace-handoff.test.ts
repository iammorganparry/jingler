import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { exportWorkspaceHandoff, importWorkspaceHandoff } from "./workspace-handoff.js"

const git = (cwd: string, args: readonly string[]) =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim()

const repository = (): string => {
  const path = mkdtempSync(join(tmpdir(), "jingler-handoff-"))
  git(path, ["init", "-b", "main"])
  git(path, ["config", "user.name", "Jingler Test"])
  git(path, ["config", "user.email", "test@jingler.dev"])
  writeFileSync(join(path, "tracked.txt"), "base\n")
  writeFileSync(join(path, "staged.txt"), "base\n")
  git(path, ["add", "."])
  git(path, ["commit", "-m", "base"])
  return path
}

describe("workspace handoff", () => {
  it("restores staged unstaged and untracked state at the exact Git base", async () => {
    const source = repository()
    writeFileSync(join(source, "tracked.txt"), "changed\n")
    writeFileSync(join(source, "staged.txt"), "staged\n")
    git(source, ["add", "staged.txt"])
    writeFileSync(join(source, "untracked.bin"), Buffer.from([0, 1, 2, 255]))
    const checkpoint = await exportWorkspaceHandoff({
      workspacePath: source,
      sourceSessionId: "session_source",
      eventCursor: 17
    })

    const target = mkdtempSync(join(tmpdir(), "jingler-handoff-target-"))
    git(target, ["clone", "--quiet", source, "."])
    git(target, ["reset", "--hard", checkpoint.headSha])
    await importWorkspaceHandoff(target, checkpoint)

    expect(readFileSync(join(target, "tracked.txt"), "utf8")).toBe("changed\n")
    expect(readFileSync(join(target, "staged.txt"), "utf8")).toBe("staged\n")
    expect([...readFileSync(join(target, "untracked.bin"))]).toEqual([0, 1, 2, 255])
    expect(git(target, ["diff", "--cached", "--name-only"])).toBe("staged.txt")
    expect(checkpoint.eventCursor).toBe(17)
  })

  it("rejects a target at a different commit before writing files", async () => {
    const source = repository()
    const checkpoint = await exportWorkspaceHandoff({
      workspacePath: source,
      sourceSessionId: "session_source",
      eventCursor: 0
    })
    writeFileSync(join(source, "later.txt"), "later\n")
    git(source, ["add", "."])
    git(source, ["commit", "-m", "later"])
    await expect(importWorkspaceHandoff(source, checkpoint)).rejects.toThrow(
      "HEAD does not match"
    )
  })
})
