import { mkdtemp, mkdir, readFile, realpath, rm, symlink, link, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listNotes, readNote, validateRoot, writeNote } from "./vault.js"

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "obsidian-test-")))
  await writeFile(join(root, "note.md"), "# Original")
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
describe("local vault", () => {
  it("lists nested Markdown and excludes hidden metadata and non-Markdown", async () => {
    await mkdir(join(root, "folder")); await mkdir(join(root, ".obsidian"))
    await writeFile(join(root, "folder", "next.md"), "next")
    await writeFile(join(root, ".obsidian", "hidden.md"), "hidden")
    await writeFile(join(root, "image.png"), "image")
    expect(await listNotes(root)).toEqual(["folder/next.md", "note.md"])
  })
  it("updates with a revision and rejects external concurrent edits", async () => {
    const first = await readNote(root, "note.md")
    const next = await writeNote(root, "note.md", "# Changed", first.revision)
    expect(next.revision).not.toBe(first.revision)
    await writeFile(join(root, "note.md"), "External edit")
    await expect(writeNote(root, "note.md", "Clobber", next.revision)).rejects.toThrow("Revision conflict")
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("External edit")
  })
  it("serializes competing plugin writes", async () => {
    const note = await readNote(root, "note.md")
    const results = await Promise.allSettled([
      writeNote(root, note.path, "one", note.revision), writeNote(root, note.path, "two", note.revision)
    ])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
  })
  it.each(["../note.md", "/note.md", "folder/../note.md", "folder\\note.md", "note.txt", ".obsidian/config.md", "C:/note.md", "note.md\0"])("rejects unsafe path %s on read and write", async (path) => {
    await expect(readNote(root, path)).rejects.toThrow()
    await expect(writeNote(root, path, "bad", "revision")).rejects.toThrow()
  })
  it("rejects symlink files, directory escapes, and root symlinks", async () => {
    await symlink(join(root, "note.md"), join(root, "alias.md"))
    await symlink(root, join(root, "alias"))
    await expect(readNote(root, "alias.md")).rejects.toThrow()
    await expect(writeNote(root, "alias.md", "bad", "revision")).rejects.toThrow()
    await expect(readNote(root, "alias/note.md")).rejects.toThrow()
    await expect(validateRoot(join(root, "alias"))).rejects.toThrow()
    expect(await listNotes(root)).toEqual(["note.md"])
  })
  it("rejects a file swapped to a symlink after reading", async () => {
    const note = await readNote(root, "note.md")
    await writeFile(join(root, "outside.md"), "preserve")
    await rm(join(root, "note.md"))
    await symlink(join(root, "outside.md"), join(root, "note.md"))
    await expect(writeNote(root, note.path, "bad", note.revision)).rejects.toThrow()
    expect(await readFile(join(root, "outside.md"), "utf8")).toBe("preserve")
  })
  it("rejects hard links, oversized notes, missing revisions, and invalid roots", async () => {
    await link(join(root, "note.md"), join(root, "hard.md"))
    await expect(readNote(root, "hard.md")).rejects.toThrow("hard links")
    await expect(writeNote(root, "hard.md", "bad", "revision")).rejects.toThrow()
    await writeFile(join(root, "large.md"), "x".repeat(1_000_001))
    await expect(readNote(root, "large.md")).rejects.toThrow("too large")
    await expect(writeNote(root, "note.md", "bad", undefined)).rejects.toThrow("revision")
    for (const value of ["relative", "/", join(root, "note.md"), 123]) await expect(validateRoot(value)).rejects.toThrow()
  })
})
