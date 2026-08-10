import { execFile } from "node:child_process"
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
import { unifiedDiffStats } from "./unified-diff.js"

const exec = promisify(execFile)
const ARTIFACT_ID = /^[0-9a-f-]+$/i

export interface WorktreeSnapshot {
  readonly cwd: string
  readonly tree: string
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
    maxBuffer: 32 * 1024 * 1024,
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

const captureTree = async (cwd: string): Promise<string> => {
  const temporary = await mkdtemp(join(tmpdir(), "jingler-index-"))
  const environment = { GIT_INDEX_FILE: join(temporary, "index") }
  try {
    const head = await gitMaybe(cwd, ["rev-parse", "--verify", "HEAD"])
    await git(cwd, head === null ? ["read-tree", "--empty"] : ["read-tree", "HEAD"], environment)
    await git(cwd, ["add", "-A", "--", "."], environment)
    return (await git(cwd, ["write-tree"], environment)).trim()
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

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

  constructor(input: { readonly artifactDir: string; readonly sessionId: string; readonly maxArtifactBytes?: number }) {
    this.#artifactDir = input.artifactDir
    this.#sessionId = input.sessionId
    this.#maxArtifactBytes = input.maxArtifactBytes ?? 2 * 1024 * 1024
  }

  capture(cwd: string): Effect.Effect<WorktreeSnapshot, FileChangeTrackerError> {
    return trackerEffect("Failed to capture worktree state", () =>
      this.#capture(cwd)
    )
  }

  async #capture(cwd: string): Promise<WorktreeSnapshot> {
    const canonical = await realpath(cwd)
    return { cwd: canonical, tree: await captureTree(canonical) }
  }

  async #writeArtifact(patch: string): Promise<FileChangeArtifact> {
    const id = randomUUID()
    const encoded = Buffer.from(patch)
    const truncated = encoded.byteLength > this.#maxArtifactBytes
    const stored = truncated ? encoded.subarray(0, this.#maxArtifactBytes) : encoded
    await mkdir(this.#artifactDir, { recursive: true })
    const path = join(this.#artifactDir, `${id}.diff`)
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, stored)
    await rename(temporary, path)
    return {
      id,
      mediaType: "text/x-diff",
      byteLength: stored.byteLength,
      sha256: createHash("sha256").update(stored).digest("hex"),
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
      this.#compare(before, cwd, callId)
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
      const patch = await git(after.cwd, ["diff", "--find-renames", "--binary", "--no-ext-diff", before.tree, after.tree, "--", ...selectedPaths])
      const stats = unifiedDiffStats(patch)
      const artifact = stats.binary || patch.length === 0 ? null : await this.#writeArtifact(patch)
      return {
        ...entry,
        added: stats.added,
        removed: stats.removed,
        binary: stats.binary,
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
