import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  fileChangeTotals,
  type FileChange,
  type FileChangeArtifact,
  type FileChangeSet,
  type FileChangeStatus
} from "@jingler/core"
import { Data, Effect } from "effect"
import { gitDiffStat, unifiedDiffStats } from "./unified-diff.js"

const exec = promisify(execFile)
const ARTIFACT_ID = /^[0-9a-f-]+$/i
const GIT_OUTPUT_BYTES = 32 * 1024 * 1024
const GIT_ERROR_BYTES = 64 * 1024

export interface WorktreeSnapshot {
  readonly cwd: string
  readonly tree: string
}

interface ShadowIndex {
  readonly cwd: string
  readonly directory: string
  readonly environment: Readonly<Record<string, string>>
}

export class FileChangeTrackerError extends Data.TaggedError(
  "FileChangeTrackerError"
)<{ readonly message: string; readonly cause?: unknown }> {}

const trackerEffect = <A>(message: string, operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new FileChangeTrackerError({ message, cause })
  })

interface ChangedPath {
  readonly status: FileChangeStatus
  readonly path: string
  readonly oldPath: string | null
}

const git = async (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>
): Promise<string> => {
  const result = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_BYTES,
    env: env ? { ...process.env, ...env } : process.env
  })
  return result.stdout
}

const gitMaybe = async (cwd: string, args: ReadonlyArray<string>): Promise<string | null> => {
  try {
    return (await git(cwd, args)).trim()
  } catch {
    return null
  }
}

interface BoundedGitOutput {
  readonly bytes: Buffer
  readonly truncated: boolean
}

const boundedGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  maxBytes: number
): Promise<BoundedGitOutput> => new Promise((resolve, reject) => {
  const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] })
  const stdout: Array<Buffer> = []
  const stderr: Array<Buffer> = []
  let stdoutBytes = 0
  let stderrBytes = 0
  const captureBytes = maxBytes + 1

  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBytes >= captureBytes) return
    const retained = chunk.subarray(0, captureBytes - stdoutBytes)
    stdout.push(retained)
    stdoutBytes += retained.byteLength
  })
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= GIT_ERROR_BYTES) return
    const retained = chunk.subarray(0, GIT_ERROR_BYTES - stderrBytes)
    stderr.push(retained)
    stderrBytes += retained.byteLength
  })
  child.once("error", reject)
  child.once("close", (code, signal) => {
    if (code !== 0) {
      const detail = Buffer.concat(stderr).toString("utf8").trim()
      reject(new Error(`git exited with ${code ?? signal ?? "unknown status"}${detail.length === 0 ? "" : `: ${detail}`}`))
      return
    }
    const output = Buffer.concat(stdout)
    resolve({
      bytes: output.subarray(0, maxBytes),
      truncated: output.byteLength > maxBytes
    })
  })
})

const changedPaths = (raw: string): ReadonlyArray<ChangedPath> => {
  const fields = raw.split("\0").filter((field) => field.length > 0)
  const changes: Array<ChangedPath> = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index++]!
    if (code.startsWith("R")) {
      const oldPath = fields[index++]!
      const path = fields[index++]!
      changes.push({ status: "R", path, oldPath })
      continue
    }
    const path = fields[index++]!
    const status: FileChangeStatus = code.startsWith("A")
      ? "A"
      : code.startsWith("D")
        ? "D"
        : "M"
    changes.push({ status, path, oldPath: null })
  }
  return changes
}

const treeSize = async (cwd: string, tree: string, path: string | null): Promise<number | null> => {
  if (path === null) return null
  const value = await gitMaybe(cwd, ["cat-file", "-s", `${tree}:${path}`])
  return value === null ? null : Number(value)
}

export class FileChangeTracker {
  readonly #artifactDir: string
  readonly #sessionId: string
  readonly #maxArtifactBytes: number
  readonly #shadowIndexRoot: string
  #shadowIndex: ShadowIndex | null = null
  #operations: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(input: {
    readonly artifactDir: string
    readonly sessionId: string
    readonly maxArtifactBytes?: number
    readonly shadowIndexRoot?: string
  }) {
    this.#artifactDir = input.artifactDir
    this.#sessionId = input.sessionId
    this.#maxArtifactBytes = input.maxArtifactBytes ?? 2 * 1024 * 1024
    this.#shadowIndexRoot = input.shadowIndexRoot ?? tmpdir()
  }

  #serialized<A>(operation: () => Promise<A>): Promise<A> {
    const result = this.#operations.then(operation, operation)
    this.#operations = result.then(() => undefined, () => undefined)
    return result
  }

  async #indexFor(cwd: string): Promise<ShadowIndex> {
    if (this.#disposed) throw new Error("file-change tracker is disposed")
    if (this.#shadowIndex !== null) {
      if (this.#shadowIndex.cwd !== cwd) throw new Error("file-change tracker cannot span worktrees")
      return this.#shadowIndex
    }
    const directory = await mkdtemp(join(this.#shadowIndexRoot, "jingler-index-"))
    const shadow = {
      cwd,
      directory,
      environment: { GIT_INDEX_FILE: join(directory, "index") }
    }
    try {
      const head = await gitMaybe(cwd, ["rev-parse", "--verify", "HEAD"])
      await git(cwd, head === null ? ["read-tree", "--empty"] : ["read-tree", "HEAD"], shadow.environment)
      this.#shadowIndex = shadow
      return shadow
    } catch (cause) {
      await rm(directory, { recursive: true, force: true })
      throw cause
    }
  }

  capture(cwd: string): Effect.Effect<WorktreeSnapshot, FileChangeTrackerError> {
    return trackerEffect("Failed to capture worktree state", () =>
      this.#serialized(() => this.#capture(cwd))
    )
  }

  async #capture(cwd: string): Promise<WorktreeSnapshot> {
    const canonical = await realpath(cwd)
    const shadow = await this.#indexFor(canonical)
    await git(canonical, ["add", "-A", "--", "."], shadow.environment)
    return { cwd: canonical, tree: (await git(canonical, ["write-tree"], shadow.environment)).trim() }
  }

  dispose(): Effect.Effect<void, FileChangeTrackerError> {
    return trackerEffect("Failed to dispose file-change tracker", () =>
      this.#serialized(async () => {
        this.#disposed = true
        const shadow = this.#shadowIndex
        this.#shadowIndex = null
        if (shadow !== null) await rm(shadow.directory, { recursive: true, force: true })
      })
    )
  }

  async #writeArtifact(patch: Buffer, truncated: boolean): Promise<FileChangeArtifact> {
    const id = randomUUID()
    await mkdir(this.#artifactDir, { recursive: true })
    const path = join(this.#artifactDir, `${id}.diff`)
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, patch)
    await rename(temporary, path)
    return {
      id,
      mediaType: "text/x-diff",
      byteLength: patch.byteLength,
      sha256: createHash("sha256").update(patch).digest("hex"),
      truncated,
      sessionId: this.#sessionId,
      createdAt: new Date().toISOString()
    }
  }

  readArtifact(id: string): Effect.Effect<string, FileChangeTrackerError> {
    return trackerEffect("Failed to read file-change artifact", async () => {
      if (!ARTIFACT_ID.test(id)) throw new Error("invalid artifact id")
      return readFile(join(this.#artifactDir, `${id}.diff`), "utf8")
    })
  }

  compare(
    before: WorktreeSnapshot,
    cwd: string,
    callId: string | null = null
  ): Effect.Effect<FileChangeSet, FileChangeTrackerError> {
    return trackerEffect("Failed to compare worktree state", () =>
      this.#serialized(() => this.#compare(before, cwd, callId))
    )
  }

  async #compare(
    before: WorktreeSnapshot,
    cwd: string,
    callId: string | null
  ): Promise<FileChangeSet> {
    const after = await this.#capture(cwd)
    if (after.cwd !== before.cwd) throw new Error("cannot compare different worktrees")
    const status = await git(after.cwd, ["diff", "--name-status", "-z", "--find-renames", before.tree, after.tree])
    const paths = changedPaths(status)
    const changes = await Promise.all(paths.map(async (entry): Promise<FileChange> => {
      const selectedPaths = entry.oldPath === null ? [entry.path] : [entry.oldPath, entry.path]
      const diffArgs = ["diff", "--find-renames", "--no-ext-diff", before.tree, after.tree, "--", ...selectedPaths]
      const counts = gitDiffStat(await git(after.cwd, ["diff", "--numstat", "-z", "--find-renames", before.tree, after.tree, "--", ...selectedPaths]))
      const patch = counts.binary
        ? { bytes: Buffer.alloc(0), truncated: false }
        : await boundedGit(after.cwd, diffArgs, this.#maxArtifactBytes)
      const stats = unifiedDiffStats(patch.bytes.toString("utf8"))
      const artifact = patch.bytes.length === 0 ? null : await this.#writeArtifact(patch.bytes, patch.truncated)
      return {
        ...entry,
        added: counts.added,
        removed: counts.removed,
        binary: counts.binary,
        noNewlineAtEnd: stats.noNewlineAtEnd,
        beforeBytes: await treeSize(after.cwd, before.tree, entry.oldPath ?? (entry.status === "A" ? null : entry.path)),
        afterBytes: await treeSize(after.cwd, after.tree, entry.status === "D" ? null : entry.path),
        preview: stats.preview,
        patchArtifactId: artifact?.id ?? null
      }
    }))
    return {
      id: randomUUID(),
      callId,
      changes,
      totals: fileChangeTotals(changes),
      authoritative: true,
      reconciledAt: new Date().toISOString()
    }
  }

  reconcile(
    before: WorktreeSnapshot,
    cwd: string
  ): Effect.Effect<FileChangeSet, FileChangeTrackerError> {
    return this.compare(before, cwd, null)
  }
}
