import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import { dirname, basename, isAbsolute } from "node:path"
import type { AnchoredRequest } from "./anchored-fs.js"

const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = fs.constants
const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino

/** A dedicated process owns cwd. Every descent verifies the held no-follow inode
 * against cwd before doing anything there. Renames cannot redirect relative I/O.
 * Descriptor-path traversal is not supported by Darwin; do not substitute it. */
export const enterDirectory = (path: string, create = false, privateDirectory = false, beforeEnter?: (part: string) => void): void => {
  if (process.platform === "win32") throw new Error("Anchored filesystem operations require POSIX directory ownership.")
  if (!isAbsolute(path) || path.split("/").includes("..")) throw new Error("Unsafe filesystem ancestor.")
  // macOS system aliases, not arbitrary user-controlled symlinks.
  if (process.platform === "darwin") path = path.replace(/^\/var(?=\/|$)/, "/private/var").replace(/^\/tmp(?=\/|$)/, "/private/tmp")
  process.chdir("/")
  const parts = path.split("/").filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (create) {
      try { fs.mkdirSync(part, { mode: 0o700 }) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause }
    }
    const fd = fs.openSync(part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    try {
      const info = fs.fstatSync(fd)
      beforeEnter?.(part)
      process.chdir(part)
      if (!same(info, fs.statSync("."))) throw new Error("Filesystem ancestor changed during descent.")
      if (privateDirectory && i === parts.length - 1) {
        if (info.uid !== process.getuid?.()) throw new Error("Private storage owner mismatch.")
        fs.fchmodSync(fd, 0o700)
      }
    } finally { fs.closeSync(fd) }
  }
}
const name = (path: string) => {
  const value = basename(path)
  if (!value || value === "." || value === "..") throw new Error("Unsafe file name.")
  return value
}
const stat = (path: string) => {
  try { const s = fs.lstatSync(path); return { mode: s.mode & 0o777, size: s.size, file: s.isFile(), directory: s.isDirectory(), symlink: s.isSymbolicLink(), nlink: s.nlink } }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause }
}
const read = (path: string, limit: number) => {
  const fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile() || info.size > limit) throw new Error("Unsafe file or file size limit exceeded.")
    const bytes = fs.readFileSync(fd)
    if (bytes.length > limit) throw new Error("File size limit exceeded.")
    return { bytes: bytes.toString("base64"), mode: info.mode & 0o777, nlink: info.nlink }
  } finally { fs.closeSync(fd) }
}
const removeDirectory = (entry: string): void => {
  const fd = fs.openSync(entry, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  const parent = fs.openSync(".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  try {
    const info = fs.fstatSync(fd)
    process.chdir(entry)
    if (!same(info, fs.statSync("."))) throw new Error("Filesystem ancestor changed during removal.")
    for (const child of fs.readdirSync(".")) {
      const s = fs.lstatSync(child)
      if (s.isDirectory()) removeDirectory(child)
      else fs.unlinkSync(child) // Unlink a symlink itself, never its target.
    }
    process.chdir("..")
    if (!same(fs.fstatSync(parent), fs.statSync("."))) throw new Error("Storage ancestor moved during removal; retained for recovery.")
    if (!same(info, fs.lstatSync(entry))) throw new Error("Storage directory replaced during removal.")
    fs.rmdirSync(entry)
  } finally { fs.closeSync(fd); fs.closeSync(parent) }
}
export const operate = (request: AnchoredRequest): unknown => {
  if (request.op === "mkdir") { enterDirectory(request.path, true, true); return null }
  if (request.op === "git") {
    enterDirectory(request.path)
    const env = { ...process.env, ...request.env }
    for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !(key in (request.env ?? {}))) delete env[key]
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...request.args!], {
      cwd: ".", env, input: request.bytes ? Buffer.from(request.bytes, "base64") : undefined,
      timeout: 30_000, maxBuffer: 34 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"]
    }).toString("base64")
  }
  enterDirectory(dirname(request.path), request.createParents)
  const file = name(request.path)
  switch (request.op) {
    case "read": return read(file, request.limit ?? 32 * 1024 * 1024)
    case "stat": return stat(file)
    case "list": {
      enterDirectory(request.path)
      return fs.readdirSync(".")
    }
    case "remove": {
      const info = stat(file)
      if (!info) return null
      if (info.directory) removeDirectory(file)
      else fs.unlinkSync(file)
      return null
    }
    case "rename": {
      if (dirname(request.to!) !== dirname(request.path)) throw new Error("Atomic rename requires one anchored directory.")
      fs.renameSync(file, name(request.to!)); return null
    }
    case "write": {
      const existing = stat(file)
      if (existing && (!existing.file || existing.symlink)) throw new Error("Unsafe file destination.")
      if (request.exclusive && existing) throw new Error("File destination already exists.")
      const temporary = `.jingler-write-${randomUUID()}`
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, request.mode ?? 0o600)
      try {
        fs.writeFileSync(fd, Buffer.from(request.bytes!, "base64"))
        fs.fchmodSync(fd, request.mode ?? 0o600)
        fs.fsyncSync(fd)
        if (request.exclusive) { fs.linkSync(temporary, file); fs.unlinkSync(temporary) }
        else fs.renameSync(temporary, file) // Break hardlinks instead of truncating their inode.
      } finally { fs.closeSync(fd); try { fs.unlinkSync(temporary) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause } }
      return null
    }
  }
}
const parentPort = (process as unknown as { parentPort?: { postMessage(message: unknown): void; on(event: "message", handler: (event: { data: AnchoredRequest & { id: number } }) => void): void } }).parentPort
const send = (message: unknown) => {
  if (parentPort) parentPort.postMessage(message)
  else process.send?.(message)
}
const receive = (request: AnchoredRequest & { id: number }) => {
  try { send({ id: request.id, value: operate(request) }) }
  catch (cause) { send({ id: request.id, error: cause instanceof Error ? cause.message : String(cause), code: (cause as NodeJS.ErrnoException).code ?? (cause as { status?: number }).status }) }
}
if (parentPort) parentPort.on("message", (event) => receive(event.data))
else if (process.send) { process.on("message", receive); process.on("disconnect", () => process.exit()) }
