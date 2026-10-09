import { constants, type Dirent } from "node:fs"
import { lstat, open, opendir, realpath, rename, rm } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

export interface Note { path: string; content: string; revision: string }
class UnsafePathError extends Error {}
const MAX_BYTES = 1_000_000
const revision = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

export async function validateRoot(value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error("Enter an absolute local vault directory.")
  }
  const root = resolve(value)
  if (root === resolve(root, "..")) throw new Error("The filesystem root cannot be a vault.")
  // Reject symlinks in all components, including the configured root itself.
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
    throw new UnsafePathError("Vault must be a real directory without symlink components.")
  }
  return root
}

function supportedName(part: string): boolean {
  return !!part && part !== "." && part !== ".." && !part.startsWith(".") && !/[\\:\0]/u.test(part)
}
function noteParts(value: unknown): string[] {
  if (typeof value !== "string" || !value.endsWith(".md")) throw new Error("Only relative .md note paths are allowed.")
  const parts = value.split("/")
  if (!parts.every(supportedName)) throw new Error("Invalid note path.")
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
      throw new UnsafePathError("Notes and directories must not be symlinks or special files.")
    }
  }
  if (!(await realpath(current)).startsWith(root + sep)) throw new UnsafePathError("Note escapes the vault.")
  return current
}

async function withNote<T>(root: string, path: string, run: (file: Awaited<ReturnType<typeof open>>) => Promise<T>): Promise<T> {
  const target = await checkedPath(root, path)
  const before = await lstat(target)
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
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
  return withNote(root, path, async (file) => {
    const bytes = await readBytes(file)
    return { path, content: decode(bytes), revision: revision(bytes) }
  })
}

function decode(bytes: Uint8Array): string {
  try { return decoder.decode(bytes) } catch { throw new Error("Note must contain valid UTF-8.") }
}
async function readBytes(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_BYTES + 1)
  let size = 0
  while (size < bytes.length) {
    const result = await file.read(bytes, size, bytes.length - size, size)
    if (!result.bytesRead) break
    size += result.bytesRead
  }
  if (size > MAX_BYTES) throw new Error("Note is too large.")
  return bytes.subarray(0, size)
}

// ponytail: one queue for plugin writes; use per-vault queues if throughput matters.
let writes: Promise<unknown> = Promise.resolve()
export function writeNote(root: string, path: string, content: unknown, expectedRevision: unknown, signal?: AbortSignal, checkConfiguration?: () => void): Promise<Note> {
  const operation = writes.catch(() => undefined).then(async () => {
    signal?.throwIfAborted()
    checkConfiguration?.()
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES || typeof expectedRevision !== "string" || !expectedRevision) {
      throw new Error("A bounded Markdown body and the revision from read are required.")
    }
    const bytes = Buffer.from(content)
    if (decode(bytes) !== content) throw new Error("Markdown must contain valid Unicode.")
    return withNote(root, path, async (file) => {
      const original = await file.stat()
      if (revision(await readBytes(file)) !== expectedRevision) throw new Error("Revision conflict: read the note again before writing.")
      const target = await checkedPath(root, path)
      const temporary = join(dirname(target), `.jingler-${randomUUID()}.tmp`)
      const staged = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        try {
          await staged.writeFile(bytes)
          await staged.chmod(original.mode & 0o7777)
          await staged.sync()
        } finally { await staged.close() }
        await withNote(root, path, async (current) => {
          const stat = await current.stat()
          if (stat.ino !== original.ino || stat.dev !== original.dev || revision(await readBytes(current)) !== expectedRevision) {
            throw new Error("Revision conflict: read the note again before writing.")
          }
          const latest = await lstat(target)
          if (latest.ino !== original.ino || latest.dev !== original.dev || latest.nlink !== 1 || !latest.isFile()) {
            throw new Error("Note changed before replacement.")
          }
          signal?.throwIfAborted()
          checkConfiguration?.()
          // Node has no atomic compare-and-swap for a pathname; a hostile external
          // rename/symlink swap can still race this final validation and rename.
          await rename(temporary, target)
        })
        return { path, content, revision: revision(bytes) }
      } finally { await rm(temporary, { force: true }) }
    })
  })
  writes = operation
  return operation
}

const vanished = (cause: unknown) => cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR")
const skippableEntry = (cause: unknown) => vanished(cause) || cause instanceof UnsafePathError
async function listableNote(root: string, path: string): Promise<boolean> {
  try {
    await checkedPath(root, path)
    return true
  } catch (cause) {
    if (!skippableEntry(cause)) throw cause
    return false
  }
}
export async function listNotes(root: string): Promise<string[]> {
  await validateRoot(root)
  const notes: string[] = []
  let entries = 0
  async function visit(entry: Dirent, relative: string, depth: number): Promise<void> {
    if (!supportedName(entry.name) || entry.isSymbolicLink()) return
    const path = [relative, entry.name].filter(Boolean).join("/")
    if (entry.isDirectory()) {
      try { await walk(path, depth + 1) } catch (cause) { if (!skippableEntry(cause)) throw cause }
    } else if (entry.isFile() && entry.name.endsWith(".md") && await listableNote(root, path)) notes.push(path)
  }
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 20) throw new Error("Vault nesting exceeds 20 levels.")
    const dir = join(root, relative)
    await validateRoot(dir)
    for await (const entry of await opendir(dir)) {
      if (++entries > 10_000) throw new Error("Vault exceeds 10,000 entries (including hidden entries).")
      await visit(entry, relative, depth)
    }
  }
  await walk("", 0)
  return notes.sort()
}
