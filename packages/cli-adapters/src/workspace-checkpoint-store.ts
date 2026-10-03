import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { Schema } from "effect"
import { WorkspaceCheckpoint, type WorkspaceCheckpointPreview } from "@jingler/core"

const exec = promisify(execFile)
const HASH = /^[a-f0-9]{40}$/
const ID = /^[a-f0-9-]{36}$/
const MAX_FILES = 10_000
const MAX_BYTES = 32 * 1024 * 1024
const STORAGE_BYTES = 128 * 1024 * 1024
const KEEP = 20
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex")
const Entry = Schema.Struct({ path: Schema.String, oid: Schema.String, mode: Schema.Literal("100644", "100755"), sha256: Schema.String })
const Snapshot = Schema.Struct({
  summary: WorkspaceCheckpoint, branch: Schema.String, repository: Schema.String,
  index: Schema.Array(Entry), files: Schema.Array(Entry)
})
type Entry = typeof Entry.Type
type Snapshot = typeof Snapshot.Type
interface Current { head: string; branch: string; repository: string; indexPath: string; index: Entry[]; files: Entry[]; indexTree: string; worktreeTree: string; blobs: Map<string, Buffer>; tracked: Set<string> }

const git = async (cwd: string, args: string[], index?: string): Promise<Buffer> => {
  // Inherited GIT_INDEX_FILE must never redirect the user's index or a linked worktree.
  const env = { ...process.env }
  delete env.GIT_INDEX_FILE
  if (index !== undefined) env.GIT_INDEX_FILE = index
  return (await exec("git", ["-C", cwd, ...args], { env, encoding: "buffer", maxBuffer: MAX_BYTES + 1024 * 1024 })).stdout
}
const text = async (cwd: string, args: string[], index?: string): Promise<string> => (await git(cwd, args, index)).toString("utf8").trim()
const safePath = (path: string): void => {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error(`Unsafe checkpoint path: ${path}`)
  }
}
const containedPath = async (cwd: string, path: string): Promise<string> => {
  safePath(path)
  let current = cwd
  for (const part of path.split("/")) {
    current = join(current, part)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (info?.isSymbolicLink()) throw new Error(`Checkpoints do not support symlinks: ${path}`)
  }
  return current
}
const regularBytes = async (path: string): Promise<Buffer> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Checkpoint file is unsupported or exceeds 32 MiB.")
    return await file.readFile()
  } finally { await file.close() }
}
const entries = (raw: Buffer): Array<{ path: string; oid: string; mode: string; stage: string }> =>
  raw.toString("utf8").split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t")
    const [mode, oid, stage] = row.slice(0, tab).split(" ")
    return { path: row.slice(tab + 1), oid: oid!, mode: mode!, stage: stage! }
  })
const ignored = async (cwd: string, path: string): Promise<boolean> => {
  try { await git(cwd, ["check-ignore", "--no-index", "--quiet", "--", path]); return true }
  catch (cause) { if ((cause as { code?: number }).code === 1) return false; throw cause }
}
const fingerprint = (current: Current): string => digest(JSON.stringify({ head: current.head, branch: current.branch, index: current.index, files: current.files }))

/** Private, bounded, owner-only copies survive linked-worktree deletion; Git refs protect source trees from GC. */
export class WorkspaceCheckpointStore {
  readonly #root: string
  readonly #sessionId: string
  readonly #cwd: string
  readonly #beforeWrite?: () => Promise<void>
  constructor(input: { root: string; sessionId: string; cwd: string; beforeWrite?: () => Promise<void> }) {
    this.#root = join(input.root, digest(input.sessionId))
    this.#sessionId = input.sessionId
    this.#cwd = input.cwd
    this.#beforeWrite = input.beforeWrite
  }
  async #directory(): Promise<void> {
    await mkdir(dirname(this.#root), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.#root), 0o700)
    await mkdir(this.#root, { mode: 0o700, recursive: true })
    if ((await lstat(this.#root)).isSymbolicLink()) throw new Error("Checkpoint storage must not be a symlink.")
    await chmod(this.#root, 0o700)
  }
  async #current(): Promise<Current> {
    const cwd = await realpath(this.#cwd)
    if (await text(cwd, ["rev-parse", "--show-toplevel"]) !== cwd) throw new Error("Checkpoints require the worktree root.")
    const indexPath = resolve(cwd, await text(cwd, ["rev-parse", "--git-path", "index"]))
    const repository = await realpath(resolve(cwd, await text(cwd, ["rev-parse", "--git-common-dir"])))
    const head = await text(cwd, ["rev-parse", "--verify", "HEAD"])
    const branch = await text(cwd, ["symbolic-ref", "-q", "HEAD"]).catch(() => "(detached)")
    const config = await text(cwd, ["config", "--get-regexp", "^(filter\\.|core\\.sparseCheckout|core\\.splitIndex|extensions\\.worktreeConfig)"]).catch((cause) => {
      if ((cause as { code?: number }).code === 1) return ""
      throw cause
    })
    if (config || (await text(cwd, ["ls-files", "-v"])).split("\n").some((line) => line.startsWith("S ") || /^[a-z] /.test(line))) {
      throw new Error("Checkpoints do not support filters, sparse/split index, or assume-unchanged entries.")
    }
    const listed = entries(await git(cwd, ["ls-files", "--stage", "-z"]))
    if (listed.length > MAX_FILES || listed.some((entry) => entry.stage !== "0" || !["100644", "100755"].includes(entry.mode))) {
      throw new Error("Checkpoints do not support conflicts, symlinks, submodules, or more than 10000 files.")
    }
    const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).toString("utf8").split("\0").filter(Boolean)
    if (listed.length + untracked.length > MAX_FILES) throw new Error("Checkpoint file count limit exceeded.")
    const blobs = new Map<string, Buffer>()
    let size = 0
    const addBlob = (bytes: Buffer): string => {
      const hash = digest(bytes)
      if (!blobs.has(hash)) { size += bytes.length; blobs.set(hash, bytes) }
      if (size > MAX_BYTES) throw new Error("Checkpoint exceeds 32 MiB storage limit.")
      return hash
    }
    const index: Entry[] = []
    for (const entry of listed) {
      safePath(entry.path)
      if (await ignored(cwd, entry.path)) throw new Error(`Tracked checkpoint path is now ignored: ${entry.path}`)
      const sha256 = addBlob(await git(cwd, ["cat-file", "blob", entry.oid]))
      index.push({ path: entry.path, mode: entry.mode as Entry["mode"], oid: entry.oid, sha256 })
    }
    const files: Entry[] = []
    for (const path of [...new Set([...listed.map((entry) => entry.path), ...untracked])].sort()) {
      const absolute = await containedPath(cwd, path)
      const stat = await lstat(absolute).catch((cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return null; throw cause })
      if (stat === null) continue
      if (!stat.isFile()) throw new Error(`Checkpoint path is not a regular file: ${path}`)
      const bytes = await regularBytes(absolute)
      files.push({ path, oid: "", mode: (stat.mode & 0o111) ? "100755" : "100644", sha256: addBlob(bytes) })
    }
    const temp = await mkdtemp(join(tmpdir(), "jingler-checkpoint-"))
    try {
      const shadow = join(temp, "index")
      await writeFile(shadow, await regularBytes(indexPath), { mode: 0o600 })
      const indexTree = await text(cwd, ["write-tree"], shadow)
      await git(cwd, ["add", "-A", "--", "."], shadow)
      const worktreeTree = await text(cwd, ["write-tree"], shadow)
      const worktreeEntries = entries(await git(cwd, ["ls-files", "--stage", "-z"], shadow))
      for (const file of files) {
        const captured = worktreeEntries.find((entry) => entry.path === file.path)
        if (!captured || captured.mode !== file.mode || digest(await git(cwd, ["cat-file", "blob", captured.oid])) !== file.sha256) {
          throw new Error("Workspace changed during checkpoint capture. Retry.")
        }
        Object.assign(file, { oid: captured.oid })
      }
      if (worktreeEntries.length !== files.length) throw new Error("Workspace changed during checkpoint capture. Retry.")
      const checkIndex = await text(cwd, ["ls-files", "--stage", "-z"])
      if (checkIndex !== (await git(cwd, ["ls-files", "--stage", "-z"], join(temp, "original-index"))).toString("utf8").trim()) {
        // Compare below using the original listing; no command uses the real index for writes.
        if (JSON.stringify(entries(Buffer.from(checkIndex))) !== JSON.stringify(listed)) throw new Error("Index changed during checkpoint capture. Retry.")
      }
      return { head, branch, repository, indexPath, index, files, blobs, indexTree, worktreeTree, tracked: new Set(listed.map((entry) => entry.path)) }
    } finally { await rm(temp, { recursive: true, force: true }) }
  }
  #ref(snapshot: Snapshot, kind: string): string {
    return `refs/jingler/checkpoints/${digest(snapshot.repository)}/${digest(this.#sessionId)}/${snapshot.summary.id}/${kind}`
  }
  async #read(id: string): Promise<Snapshot> {
    if (!ID.test(id)) throw new Error("Invalid checkpoint identity.")
    const snapshot = Schema.decodeUnknownSync(Snapshot)(JSON.parse(await readFile(join(this.#root, id, "snapshot.json"), "utf8")))
    if (snapshot.summary.id !== id || snapshot.summary.sessionId !== this.#sessionId) throw new Error("Checkpoint ownership mismatch.")
    for (const entry of [...snapshot.index, ...snapshot.files]) {
      safePath(entry.path)
      if (!HASH.test(entry.oid) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Corrupt checkpoint manifest.")
      const bytes = await regularBytes(join(this.#root, id, entry.sha256))
      if (digest(bytes) !== entry.sha256) throw new Error("Corrupt checkpoint contents.")
    }
    return snapshot
  }
  async list(): Promise<WorkspaceCheckpoint[]> {
    await this.#directory()
    const snapshots: WorkspaceCheckpoint[] = []
    for (const id of await readdir(this.#root)) {
      if (ID.test(id)) snapshots.push((await this.#read(id)).summary)
    }
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async #save(current: Current, label: string, pinned = false): Promise<WorkspaceCheckpoint> {
    await this.#directory()
    const existing = await this.list()
    const byteLength = [...current.blobs.values()].reduce((sum, bytes) => sum + bytes.length, 0)
    const evict: WorkspaceCheckpoint[] = []
    let total = existing.reduce((sum, snapshot) => sum + snapshot.byteLength, 0) + byteLength
    let count = existing.length + 1
    for (const snapshot of [...existing].reverse()) {
      if (total <= STORAGE_BYTES && count <= KEEP) break
      if (snapshot.pinned) continue
      evict.push(snapshot); total -= snapshot.byteLength; count--
    }
    if (total > STORAGE_BYTES || count > KEEP) throw new Error("Checkpoint storage is full; pinned recovery backups are retained.")
    const id = randomUUID()
    const summary: WorkspaceCheckpoint = { id, sessionId: this.#sessionId, createdAt: new Date().toISOString(), label, head: current.head, indexTree: current.indexTree, worktreeTree: current.worktreeTree, pinned, byteLength }
    const snapshot: Snapshot = { summary, branch: current.branch, repository: current.repository, index: current.index, files: current.files }
    const temporary = join(this.#root, `${id}.tmp`)
    await mkdir(temporary, { mode: 0o700 })
    try {
      for (const [hash, bytes] of current.blobs) await writeFile(join(temporary, hash), bytes, { mode: 0o600, flag: "wx" })
      await writeFile(join(temporary, "snapshot.json"), JSON.stringify(snapshot), { mode: 0o600, flag: "wx" })
      await git(this.#cwd, ["update-ref", this.#ref(snapshot, "index"), current.indexTree])
      await git(this.#cwd, ["update-ref", this.#ref(snapshot, "worktree"), current.worktreeTree])
      await rename(temporary, join(this.#root, id))
      for (const old of evict) {
        const prior = await this.#read(old.id)
        await git(this.#cwd, ["update-ref", "-d", this.#ref(prior, "index")])
        await git(this.#cwd, ["update-ref", "-d", this.#ref(prior, "worktree")])
        await rm(join(this.#root, old.id), { recursive: true })
      }
      return summary
    } catch (cause) { await rm(temporary, { recursive: true, force: true }); throw cause }
  }
  async capture(label = "Manual checkpoint"): Promise<WorkspaceCheckpoint> { return this.#save(await this.#current(), label) }
  async #preview(snapshot: Snapshot, current: Current): Promise<WorkspaceCheckpointPreview> {
    if (snapshot.summary.head !== current.head || snapshot.branch !== current.branch || snapshot.repository !== current.repository) throw new Error("HEAD or branch changed since this checkpoint; restore is refused.")
    const target = new Map(snapshot.files.map((entry) => [entry.path, entry]))
    const now = new Map(current.files.map((entry) => [entry.path, entry]))
    const operations: WorkspaceCheckpointPreview["operations"][number][] = []
    for (const path of [...new Set([...target.keys(), ...now.keys()])].sort()) {
      const to = target.get(path)
      const from = now.get(path)
      if (to && await ignored(this.#cwd, path)) throw new Error(`Checkpoint path is now ignored: ${path}`)
      await containedPath(this.#cwd, path)
      if (to && from && !current.tracked.has(path) && snapshot.index.some((entry) => entry.path === path)) throw new Error(`Later untracked collision must be resolved first: ${path}`)
      if (!to && !current.tracked.has(path)) continue // Preserve every later untracked file.
      if (to?.sha256 === from?.sha256 && to?.mode === from?.mode) continue
      operations.push({ path, action: !to ? "delete" : !from ? "create" : "overwrite" })
    }
    const rawDiff = await git(this.#cwd, ["diff", "--no-ext-diff", "--no-textconv", current.worktreeTree, snapshot.summary.worktreeTree, "--"])
    if (rawDiff.length > 1024 * 1024) throw new Error("Checkpoint diff is too large to preview safely.")
    return { checkpointId: snapshot.summary.id, token: digest(JSON.stringify({ current: fingerprint(current), snapshot, operations })), operations, diff: rawDiff.toString("utf8") }
  }
  async preview(id: string): Promise<WorkspaceCheckpointPreview> { return this.#preview(await this.#read(id), await this.#current()) }
  async restore(id: string, token: string): Promise<WorkspaceCheckpoint> {
    const snapshot = await this.#read(id)
    const current = await this.#current()
    const preview = await this.#preview(snapshot, current)
    if (preview.token !== token) throw new Error("Restore preview is stale. Preview again before confirming.")
    const backup = await this.#save(current, "Safety backup before restore", true)
    const temp = await mkdtemp(join(tmpdir(), "jingler-restore-"))
    const lock = `${current.indexPath}.lock`
    let indexLock: Awaited<ReturnType<typeof open>> | undefined
    try {
      indexLock = await open(lock, "wx", 0o600)
      const shadow = join(temp, "index")
      await git(this.#cwd, ["read-tree", snapshot.summary.indexTree], shadow)
      await this.#beforeWrite?.()
      if ((await this.#preview(snapshot, await this.#current())).token !== token) throw new Error("Workspace changed before restore. Preview again.")
      for (const operation of preview.operations) {
        const path = await containedPath(this.#cwd, operation.path)
        if (operation.action === "delete") { await unlink(path); continue }
        const entry = snapshot.files.find((file) => file.path === operation.path)!
        if (await ignored(this.#cwd, entry.path)) throw new Error(`Checkpoint path is now ignored: ${entry.path}`)
        await mkdir(dirname(path), { recursive: true })
        await containedPath(this.#cwd, operation.path)
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, entry.mode === "100755" ? 0o755 : 0o644)
        try { await file.writeFile(await regularBytes(join(this.#root, id, entry.sha256))); await file.chmod(entry.mode === "100755" ? 0o755 : 0o644) }
        finally { await file.close() }
      }
      await indexLock.writeFile(await regularBytes(shadow))
      await indexLock.close(); indexLock = undefined
      await rename(lock, current.indexPath)
      return backup
    } catch (cause) {
      throw new Error(`Restore failed. Safety backup ${backup.id} is pinned and available in Checkpoints. ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    } finally {
      if (indexLock) { await indexLock.close(); await unlink(lock) }
      await rm(temp, { recursive: true, force: true })
    }
  }
}
