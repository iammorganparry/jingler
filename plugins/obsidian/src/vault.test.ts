import { chmod, lstat, mkdtemp, mkdir, open, opendir, readFile, readdir, realpath, rename, rm, symlink, link, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { listNotes, readNote, validateRoot, writeNote } from "./vault.js"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, open: vi.fn(fs.open), lstat: vi.fn(fs.lstat), opendir: vi.fn(fs.opendir), rename: vi.fn(fs.rename) }
})

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "obsidian-test-")))
  await writeFile(join(root, "note.md"), "# Original")
})
afterEach(async () => { vi.resetAllMocks(); await rm(root, { recursive: true, force: true }) })
describe("local vault", () => {
  it("lists nested Markdown and excludes hidden metadata and non-Markdown", async () => {
    await mkdir(join(root, "folder")); await mkdir(join(root, ".obsidian"))
    await writeFile(join(root, "folder", "next.md"), "next")
    await writeFile(join(root, ".obsidian", "hidden.md"), "hidden")
    await writeFile(join(root, "image.png"), "image")
    expect(await listNotes(root)).toEqual(["folder/next.md", "note.md"])
  })
  it("skips FIFOs, unsupported names, and notes that vanish during enumeration", async () => {
    execFileSync("mkfifo", [join(root, "pipe.md")])
    await writeFile(join(root, "bad:name.md"), "skip")
    await writeFile(join(root, "bad\\name.md"), "skip")
    await writeFile(join(root, "gone.md"), "gone")
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(lstat).mockImplementation(async (path, options) => {
      if (path === join(root, "gone.md")) await rm(path, { force: true })
      return fs.lstat(path, options)
    })
    expect(await listNotes(root)).toEqual(["note.md"])
    await expect(readNote(root, "pipe.md")).rejects.toThrow("special files")
  })
  it("counts hidden entries and stops streaming enumeration at the entry limit", async () => {
    let yielded = 0
    let closed = false
    // SAFETY: listNotes consumes only the async iterable and these Dirent fields.
    vi.mocked(opendir).mockResolvedValue({ async *[Symbol.asyncIterator]() {
      try {
        for (let i = 0; i < 100_000; i++) {
          yielded++
          yield { name: `.hidden-${i}`, isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false }
        }
      } finally { closed = true }
    } } as Awaited<ReturnType<typeof opendir>>)
    await expect(listNotes(root)).rejects.toThrow("10,000 entries")
    expect(yielded).toBe(10_001)
    expect(closed).toBe(true)
  })
  it("hashes original UTF-8 bytes and preserves a BOM", async () => {
    const bytes = Buffer.from("\ufeff# Note 💡")
    await writeFile(join(root, "note.md"), bytes)
    const note = await readNote(root, "note.md")
    expect(note.content).toBe("\ufeff# Note 💡")
    expect(note.revision).toBe(createHash("sha256").update(bytes).digest("hex"))
  })
  it("rejects distinct malformed UTF-8 files rather than merging revisions", async () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xfe]), Buffer.from([0xc3])]) {
      await writeFile(join(root, "note.md"), bytes)
      await expect(readNote(root, "note.md")).rejects.toThrow("valid UTF-8")
    }
  })
  it("atomically replaces a note while preserving permissions", async () => {
    await chmod(join(root, "note.md"), 0o640)
    const original = await lstat(join(root, "note.md"))
    const note = await readNote(root, "note.md")
    await writeNote(root, note.path, "replacement", note.revision)
    const stat = await lstat(join(root, "note.md"))
    expect(stat.ino).not.toBe(original.ino)
    expect(stat.mode & 0o777).toBe(0o640)
    expect(await readdir(root)).toEqual(["note.md"])
  })
  it.each(["write", "sync", "rename"])("preserves the original and cleans staging after a %s failure", async (failure) => {
    const note = await readNote(root, "note.md")
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const file = await fs.open(path, flags, mode)
      if (String(path).endsWith(".tmp")) {
        if (failure === "write") vi.spyOn(file, "writeFile").mockImplementation(async () => {
          await file.write("partial staged bytes")
          throw new Error("ENOSPC")
        })
        else if (failure === "sync") vi.spyOn(file, "sync").mockRejectedValue(new Error("EIO"))
        else vi.mocked(rename).mockRejectedValue(new Error("EIO"))
      }
      return file
    })
    await expect(writeNote(root, note.path, "new contents", note.revision)).rejects.toThrow()
    expect(await readFile(join(root, "note.md"), "utf8")).toBe(note.content)
    expect(await readdir(root)).toEqual(["note.md"])
  })
  it("rechecks configuration before replacing a staged note", async () => {
    const note = await readNote(root, "note.md")
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let configured = true
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const file = await fs.open(path, flags, mode)
      if (String(path).endsWith(".tmp")) vi.spyOn(file, "sync").mockImplementation(async () => { configured = false })
      return file
    })
    await expect(writeNote(root, note.path, "new contents", note.revision, undefined, () => {
      if (!configured) throw new Error("Vault changed")
    })).rejects.toThrow("Vault changed")
    expect(await readFile(join(root, "note.md"), "utf8")).toBe(note.content)
    expect(await readdir(root)).toEqual(["note.md"])
  })
  it("rejects a destination inode replaced while the temporary file is staged", async () => {
    const note = await readNote(root, "note.md")
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const file = await fs.open(path, flags, mode)
      if (String(path).endsWith(".tmp")) vi.spyOn(file, "sync").mockImplementation(async () => {
        await rm(join(root, "note.md"))
        await writeFile(join(root, "note.md"), note.content)
      })
      return file
    })
    await expect(writeNote(root, note.path, "new contents", note.revision)).rejects.toThrow("Revision conflict")
    expect(await readFile(join(root, "note.md"), "utf8")).toBe(note.content)
    expect(await readdir(root)).toEqual(["note.md"])
  })
  it("updates with a revision and rejects external concurrent edits", async () => {
    const first = await readNote(root, "note.md")
    const next = await writeNote(root, "note.md", "# Changed", first.revision)
    expect(next.revision).not.toBe(first.revision)
    await writeFile(join(root, "note.md"), "External edit")
    await expect(writeNote(root, "note.md", "Clobber", next.revision)).rejects.toThrow("Revision conflict")
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("External edit")
  })
  it("does not mutate a cancelled write", async () => {
    const note = await readNote(root, "note.md")
    const controller = new AbortController()
    controller.abort()
    await expect(writeNote(root, note.path, "cancelled", note.revision, controller.signal)).rejects.toThrow()
    expect(await readFile(join(root, "note.md"), "utf8")).toBe(note.content)
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
