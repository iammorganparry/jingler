import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { isAbsolute, join, resolve, sep } from "node:path"

export interface Note { path: string; content: string; revision: string }
const MAX_BYTES = 1_000_000
const revision = (content: string) => createHash("sha256").update(content).digest("hex")

export async function validateRoot(value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error("Enter an absolute local vault directory.")
  }
  const root = resolve(value)
  if (root === resolve(root, "..")) throw new Error("The filesystem root cannot be a vault.")
  // Reject symlinks in all components, including the configured root itself.
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
    throw new Error("Vault must be a real directory without symlink components.")
  }
  return root
}

function noteParts(value: unknown): string[] {
  if (typeof value !== "string" || !value.endsWith(".md") || value.includes("\\") || value.includes("\0")) {
    throw new Error("Only relative .md note paths are allowed.")
  }
  const parts = value.split("/")
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || part.includes(":"))) {
    throw new Error("Invalid note path.")
  }
  return parts
}

async function checkedPath(root: string, path: unknown): Promise<string> {
  await validateRoot(root)
  const parts = noteParts(path)
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error("Notes and directories must not be symlinks or special files.")
    }
  }
  if (!(await realpath(current)).startsWith(root + sep)) throw new Error("Note escapes the vault.")
  return current
}

async function withNote<T>(root: string, path: string, write: boolean, run: (file: Awaited<ReturnType<typeof open>>) => Promise<T>): Promise<T> {
  const target = await checkedPath(root, path)
  const before = await lstat(target)
  const file = await open(target, (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || stat.ino !== before.ino || stat.dev !== before.dev) {
      throw new Error("Note changed, is too large, or has multiple hard links.")
    }
    await checkedPath(root, path)
    const after = await lstat(target)
    if (after.ino !== stat.ino || after.dev !== stat.dev) throw new Error("Note changed during validation.")
    return await run(file)
  } finally {
    await file.close()
  }
}

export async function readNote(root: string, path: string): Promise<Note> {
  return withNote(root, path, false, async (file) => {
    const content = await readContent(file)
    return { path, content, revision: revision(content) }
  })
}

async function readContent(file: Awaited<ReturnType<typeof open>>): Promise<string> {
  const bytes = Buffer.alloc(MAX_BYTES + 1)
  let size = 0
  while (size < bytes.length) {
    const result = await file.read(bytes, size, bytes.length - size, size)
    if (!result.bytesRead) break
    size += result.bytesRead
  }
  if (size > MAX_BYTES) throw new Error("Note is too large.")
  return bytes.subarray(0, size).toString("utf8")
}

// Serialize this plugin's writes; Obsidian edits are checked against the latest
// bytes immediately before writing through the validated descriptor.
let writes: Promise<unknown> = Promise.resolve()
export function writeNote(root: string, path: string, content: unknown, expectedRevision: unknown): Promise<Note> {
  const operation = writes.catch(() => undefined).then(async () => {
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES || typeof expectedRevision !== "string" || !expectedRevision) {
      throw new Error("A bounded Markdown body and the revision from read are required.")
    }
    return withNote(root, path, true, async (file) => {
      const current = await readContent(file)
      if (revision(current) !== expectedRevision) throw new Error("Revision conflict: read the note again before writing.")
      const bytes = Buffer.from(content)
      let offset = 0
      while (offset < bytes.length) {
        const result = await file.write(bytes, offset, bytes.length - offset, offset)
        if (!result.bytesWritten) throw new Error("Unable to write note.")
        offset += result.bytesWritten
      }
      await file.truncate(bytes.length)
      await file.sync()
      return { path, content, revision: revision(content) }
    })
  })
  writes = operation
  return operation
}

export async function listNotes(root: string): Promise<string[]> {
  await validateRoot(root)
  const notes: string[] = []
  let entries = 0
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 20) throw new Error("Vault nesting exceeds 20 levels.")
    const dir = join(root, relative)
    await validateRoot(dir)
    const visible = (await readdir(dir, { withFileTypes: true })).filter((entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink())
    for (const entry of visible) {
      if (++entries > 10_000) throw new Error("Vault exceeds 10,000 entries.")
      const path = [relative, entry.name].filter(Boolean).join("/")
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.name.endsWith(".md")) {
        await checkedPath(root, path)
        notes.push(path)
      }
    }
  }
  await walk("", 0)
  return notes.sort()
}
