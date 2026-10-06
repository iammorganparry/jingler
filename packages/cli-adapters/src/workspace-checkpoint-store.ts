import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { anchoredFs } from "./anchored-fs.js"
import { Schema } from "effect"
import { WorkspaceCheckpoint, type WorkspaceCheckpointPreview } from "@jingler/core"

const HASH = /^[a-f0-9]{40}$/
const ID = /^[a-f0-9-]{36}$/
const MAX_FILES = 10_000
const MAX_BYTES = 32 * 1024 * 1024
const STORAGE_BYTES = 128 * 1024 * 1024
const KEEP = 20
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex")
const Entry = Schema.Struct({ path: Schema.String, oid: Schema.String, mode: Schema.Literal("100644", "100755"), sha256: Schema.String, permissions: Schema.Number })
const Snapshot = Schema.Struct({
  summary: WorkspaceCheckpoint, branch: Schema.String, repository: Schema.String,
  index: Schema.Array(Entry), files: Schema.Array(Entry), indexDigest: Schema.String, verifiedBranch: Schema.String
})
type Entry = typeof Entry.Type
type Snapshot = typeof Snapshot.Type
interface Current { head: string; branch: string; repository: string; indexPath: string; index: Entry[]; files: Entry[]; indexTree: string; worktreeTree: string; blobs: Map<string, Buffer>; tracked: Set<string>; indexDigest: string }

const git = async (cwd: string, args: string[], index?: string): Promise<Buffer> => {
  return anchoredFs.git(cwd, args, index === undefined ? {} : { GIT_INDEX_FILE: index })
}
const text = async (cwd: string, args: string[], index?: string): Promise<string> => (await git(cwd, args, index)).toString("utf8").trim()
const safePath = (path: string): void => {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error(`Unsafe checkpoint path: ${path}`)
  }
}
const regularBytes = async (path: string): Promise<Buffer> => (await anchoredFs.read(path, MAX_BYTES)).bytes
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
const fingerprint = (current: Current): string => digest(JSON.stringify({ head: current.head, branch: current.branch, indexDigest: current.indexDigest, index: current.index, files: current.files }))

/** Private, bounded, owner-only copies survive linked-worktree deletion; Git refs protect source trees from GC. */
export class WorkspaceCheckpointStore {
  readonly #root: string
  readonly #sessionId: string
  readonly #cwd: string
  readonly #beforeWrite?: () => Promise<void>
  readonly #afterIndexCopy?: () => Promise<void>
  readonly #verifiedBranch: string
  constructor(input: { root: string; sessionId: string; cwd: string; beforeWrite?: () => Promise<void>; afterIndexCopy?: () => Promise<void>; verifiedBranch?: string }) {
    this.#root = join(input.root, digest(input.sessionId))
    this.#sessionId = input.sessionId
    this.#cwd = input.cwd
    this.#beforeWrite = input.beforeWrite
    this.#afterIndexCopy = input.afterIndexCopy
    this.#verifiedBranch = input.verifiedBranch ?? ""
  }
  async #directory(): Promise<void> {
    await anchoredFs.mkdir(this.#root)
  }
  async #current(): Promise<Current> {
    const cwd = this.#cwd
    if (await text(cwd, ["rev-parse", "--show-toplevel"]) !== await realpath(cwd)) throw new Error("Checkpoints require the worktree root.")
    const indexPath = resolve(cwd, await text(cwd, ["rev-parse", "--git-path", "index"]))
    const repository = await realpath(resolve(cwd, await text(cwd, ["rev-parse", "--git-common-dir"])))
    const head = await text(cwd, ["rev-parse", "--verify", "HEAD"])
    const branch = await text(cwd, ["symbolic-ref", "-q", "HEAD"]).catch((cause) => { if ((cause as { code?: number }).code === 1) return "(detached)"; throw cause })
    for (const key of ["core.sparseCheckout", "core.splitIndex"]) {
      const value = await text(cwd, ["config", "--bool", "--get", key]).catch((cause) => { if ((cause as { code?: number }).code === 1) return "false"; throw cause })
      if (value === "true") throw new Error("Checkpoints do not support sparse/split index.")
    }
    const original = await regularBytes(indexPath)
    const indexDigest = digest(original)
    const temp = await mkdtemp(join(tmpdir(), "jingler-checkpoint-"))
    try {
      const shadow = join(temp, "index")
      await anchoredFs.write(shadow, original)
      await this.#afterIndexCopy?.()
      // Every staged entry and tree is derived from this ONE immutable index copy.
      const debug = await text(cwd, ["ls-files", "--debug"], shadow)
      if ([...debug.matchAll(/flags: ([0-9a-f]+)/g)].some((match) => (Number.parseInt(match[1]!, 16) & 0x20000000) !== 0)) throw new Error("Intent-to-add (git add -N) is unsupported; original staging is unchanged.")
      if ((await text(cwd, ["ls-files", "-v"], shadow)).split("\n").some((line) => line.startsWith("S ") || /^[a-z] /.test(line))) throw new Error("Checkpoints do not support assume-unchanged/skip-worktree entries.")
      const listed = entries(await git(cwd, ["ls-files", "--stage", "-z"], shadow))
      if (listed.length > MAX_FILES || listed.some((entry) => entry.stage !== "0" || !["100644", "100755"].includes(entry.mode))) throw new Error("Checkpoints do not support conflicts, symlinks, submodules, or more than 10000 files.")
      const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], shadow)).toString("utf8").split("\0").filter(Boolean)
      const paths = [...new Set([...listed.map((entry) => entry.path), ...untracked])].sort()
      if (paths.length > MAX_FILES) throw new Error("Checkpoint file count limit exceeded.")
      for (const path of paths) safePath(path)
      const attributes = (await anchoredFs.git(cwd, ["check-attr", "-z", "--stdin", "filter"], { GIT_INDEX_FILE: shadow }, Buffer.from(paths.join("\0") + "\0"))).toString("utf8").split("\0")
      for (let i = 2; i < attributes.length; i += 3) if (!["unspecified", "unset"].includes(attributes[i]!)) throw new Error(`Checkpoint path has an unsupported Git filter: ${attributes[i - 2]}`)
      const blobs = new Map<string, Buffer>()
      let size = 0
      const addBlob = (bytes: Buffer): string => {
        const hash = digest(bytes)
        if (!blobs.has(hash)) { size += bytes.length; blobs.set(hash, bytes) }
        if (size > MAX_BYTES) throw new Error("Checkpoint exceeds 32 MiB storage limit.")
        return hash
      }
      addBlob(original)
      const index: Entry[] = []
      for (const entry of listed) {
        if (await ignored(cwd, entry.path)) throw new Error(`Tracked checkpoint path is now ignored: ${entry.path}`)
        index.push({ path: entry.path, mode: entry.mode as Entry["mode"], oid: entry.oid, sha256: addBlob(await git(cwd, ["cat-file", "blob", entry.oid])), permissions: 0o600 })
      }
      const indexTree = await text(cwd, ["write-tree"], shadow)
      const files: Entry[] = []
      for (const path of paths) {
        const absolute = join(cwd, path)
        const stat = await anchoredFs.stat(absolute).catch((cause) => { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause })
        if (!stat) continue
        if (!stat.file || stat.symlink) throw new Error(`Checkpoint path is not a regular file: ${path}`)
        const file = await anchoredFs.read(absolute, MAX_BYTES)
        const oid = (await anchoredFs.git(cwd, ["hash-object", "-w", "--stdin", "--no-filters"], {}, file.bytes)).toString("utf8").trim()
        files.push({ path, oid, mode: (file.mode & 0o111) ? "100755" : "100644", permissions: file.mode & 0o777, sha256: addBlob(file.bytes) })
      }
      await git(cwd, ["read-tree", "--empty"], shadow)
      if (files.length) await anchoredFs.git(cwd, ["update-index", "-z", "--index-info"], { GIT_INDEX_FILE: shadow }, Buffer.from(files.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join("")))
      const worktreeTree = await text(cwd, ["write-tree"], shadow)
      if (digest(await regularBytes(indexPath)) !== indexDigest || await text(cwd, ["rev-parse", "HEAD"]) !== head || await text(cwd, ["symbolic-ref", "-q", "HEAD"]).catch(() => "(detached)") !== branch) throw new Error("Index or HEAD changed during checkpoint capture. Retry.")
      // Re-read bytes, modes and enumeration, not just timestamps (which can repeat).
      for (const file of files) {
        const again = await anchoredFs.read(join(cwd, file.path), MAX_BYTES)
        if (digest(again.bytes) !== file.sha256 || again.mode !== file.permissions) throw new Error("Workspace changed during checkpoint capture. Retry.")
      }
      const againUntracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).toString("utf8").split("\0").filter(Boolean)
      if (JSON.stringify(againUntracked) !== JSON.stringify(untracked)) throw new Error("Workspace changed during checkpoint capture. Retry.")
      return { head, branch, repository, indexPath, index, files, blobs, indexTree, worktreeTree, tracked: new Set(listed.map((entry) => entry.path)), indexDigest }
    } finally { await rm(temp, { recursive: true, force: true }) }
  }

  #ref(snapshot: Snapshot, kind: string): string {
    return `refs/jingler/checkpoints/${digest(snapshot.repository)}/${digest(this.#sessionId)}/${snapshot.summary.id}/${kind}`
  }
  async #read(id: string): Promise<Snapshot> {
    if (!ID.test(id)) throw new Error("Invalid checkpoint identity.")
    const snapshot = Schema.decodeUnknownSync(Snapshot)(JSON.parse((await regularBytes(join(this.#root, id, "snapshot.json"))).toString("utf8")))
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
    for (const id of await anchoredFs.list(this.#root)) {
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
    const snapshot: Snapshot = { summary, branch: current.branch, repository: current.repository, index: current.index, files: current.files, indexDigest: current.indexDigest, verifiedBranch: this.#verifiedBranch }
    const temporary = join(this.#root, `${id}.tmp`)
    await anchoredFs.mkdir(temporary)
    try {
      for (const [hash, bytes] of current.blobs) await anchoredFs.write(join(temporary, hash), bytes, 0o600, true)
      await anchoredFs.write(join(temporary, "snapshot.json"), JSON.stringify(snapshot), 0o600, true)
      await git(this.#cwd, ["update-ref", this.#ref(snapshot, "index"), current.indexTree, "0000000000000000000000000000000000000000"])
      await git(this.#cwd, ["update-ref", this.#ref(snapshot, "worktree"), current.worktreeTree, "0000000000000000000000000000000000000000"])
      await anchoredFs.rename(temporary, join(this.#root, id))
      for (const old of evict) {
        const prior = await this.#read(old.id)
        await git(this.#cwd, ["update-ref", "-d", this.#ref(prior, "index")])
        await git(this.#cwd, ["update-ref", "-d", this.#ref(prior, "worktree")])
        await anchoredFs.remove(join(this.#root, old.id))
      }
      return summary
    } catch (cause) { await anchoredFs.remove(temporary); throw cause }
  }
  async capture(label = "Manual checkpoint"): Promise<WorkspaceCheckpoint> { return this.#save(await this.#current(), label) }
  async #preview(snapshot: Snapshot, current: Current): Promise<WorkspaceCheckpointPreview> {
    const hostActivation = snapshot.branch === "(detached)" && this.#verifiedBranch !== "" && current.branch === `refs/heads/${this.#verifiedBranch}`
    if (snapshot.summary.head !== current.head || (!hostActivation && snapshot.branch !== current.branch) || snapshot.repository !== current.repository) throw new Error("HEAD or branch changed since this checkpoint; restore is refused.")
    const target = new Map(snapshot.files.map((entry) => [entry.path, entry]))
    const now = new Map(current.files.map((entry) => [entry.path, entry]))
    const operations: WorkspaceCheckpointPreview["operations"][number][] = []
    for (const path of [...new Set([...target.keys(), ...now.keys()])].sort()) {
      const to = target.get(path)
      const from = now.get(path)
      if (to && await ignored(this.#cwd, path)) throw new Error(`Checkpoint path is now ignored: ${path}`)
      safePath(path)
      const disk = await anchoredFs.stat(join(this.#cwd, path)).catch((cause) => { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause })
      if (to && disk && !from) throw new Error(`Ignored or unsupported collision must be resolved first: ${path}`)
      if (to && from && !current.tracked.has(path) && snapshot.index.some((entry) => entry.path === path)) throw new Error(`Later untracked collision must be resolved first: ${path}`)
      if (!to && !current.tracked.has(path)) continue // Preserve every later untracked file.
      if (to?.sha256 === from?.sha256 && to?.permissions === from?.permissions) continue
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
    const lock = `${current.indexPath}.lock`
    let locked = false
    try {
      await anchoredFs.write(lock, Buffer.alloc(0), 0o600, true)
      locked = true
      await this.#beforeWrite?.()
      if ((await this.#preview(snapshot, await this.#current())).token !== token) throw new Error("Workspace changed before restore. Preview again.")
      for (const operation of preview.operations) {
        const path = join(this.#cwd, operation.path)
        if (operation.action === "delete") {
          const stat = await anchoredFs.stat(path)
          if (!stat?.file) throw new Error("Restore deletion path changed.")
          await anchoredFs.remove(path)
          continue
        }
        const entry = snapshot.files.find((file) => file.path === operation.path)!
        if (await ignored(this.#cwd, entry.path)) throw new Error(`Checkpoint path is now ignored: ${entry.path}`)
        await anchoredFs.write(path, await regularBytes(join(this.#root, id, entry.sha256)), entry.permissions)
      }
      await anchoredFs.write(lock, await regularBytes(join(this.#root, id, snapshot.indexDigest)), 0o600)
      await anchoredFs.rename(lock, current.indexPath)
      locked = false
      return backup
    } catch (cause) {
      throw new Error(`Restore failed. Safety backup ${backup.id} is pinned and available in Checkpoints. ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    } finally { if (locked) await anchoredFs.remove(lock) }

  }
}
