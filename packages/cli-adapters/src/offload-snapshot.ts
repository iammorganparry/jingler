import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"
import { gzipSync } from "node:zlib"
import {
  OFFLOAD_COMPUTE_PROTOCOL_VERSION,
  OFFLOAD_SNAPSHOT_MAX_BYTES,
  OffloadSnapshotError,
  type OffloadSnapshotIdentity
} from "@jingler/core"
import { Effect } from "effect"

const execFileAsync = promisify(execFile)
const GIT_BUFFER_BYTES = OFFLOAD_SNAPSHOT_MAX_BYTES + 1024 * 1024
const UPLOAD_CHUNK_BYTES = 64 * 1024
const SECRET_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "credentials.json"
])
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".turbo",
  "dist",
  "out",
  "coverage",
  "build"
])

interface SnapshotPayload {
  readonly version: 1
  readonly headSha: string
  readonly headArchiveBase64: string
  readonly headArchiveBytes: number
  readonly headArchiveDigest: string
  readonly headFileCount: number
  readonly stagedPatch: string
  readonly unstagedPatch: string
}

export interface CapturedOffloadSnapshot {
  readonly identity: OffloadSnapshotIdentity
  readonly compressedBytes: Uint8Array
  readonly fileCount: number
  readonly uncompressedBytes: number
}

export interface UploadOffloadSnapshotInput {
  readonly url: string
  readonly grant: string
  readonly snapshot: CapturedOffloadSnapshot
  readonly onProgress?: (completedBytes: number, totalBytes: number) => void
}

export interface UploadedOffloadSnapshot {
  readonly digest: string
  readonly compressedBytes: number
}

const failure = (
  reason: OffloadSnapshotError["reason"],
  message: string
): OffloadSnapshotError => new OffloadSnapshotError({ reason, message })

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex")

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  trim = true
): Effect.Effect<string, OffloadSnapshotError> =>
  Effect.tryPromise({
    try: () =>
      execFileAsync("git", [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_BUFFER_BYTES
      }),
    catch: () => failure("capture-failed", "Git could not capture the workspace snapshot")
  }).pipe(Effect.map((result) => trim ? result.stdout.trimEnd() : result.stdout))

const gitBytes = (
  cwd: string,
  args: ReadonlyArray<string>
): Effect.Effect<Buffer, OffloadSnapshotError> =>
  Effect.tryPromise({
    try: async () => {
      const result = await execFileAsync("git", [...args], {
        cwd,
        encoding: "buffer",
        maxBuffer: GIT_BUFFER_BYTES
      })
      return Buffer.from(result.stdout)
    },
    catch: () => failure("capture-failed", "Git could not capture the workspace snapshot")
  })

const nulPaths = (value: string): ReadonlyArray<string> =>
  value.length === 0 ? [] : value.split("\0").filter(Boolean).sort()

const treeEntries = (value: string): ReadonlyArray<{ readonly mode: string; readonly path: string }> =>
  value.split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t")
    const metadata = entry.slice(0, tab).split(" ")
    return { mode: metadata[0] ?? "", path: entry.slice(tab + 1) }
  })

const isSecretPath = (path: string): boolean => {
  const name = path.split("/").at(-1)?.toLocaleLowerCase("en-US") ?? ""
  return SECRET_NAMES.has(name) ||
    name.startsWith(".env.") ||
    name.endsWith(".pem") ||
    name.endsWith(".key")
}

const isExcludedPath = (path: string): boolean =>
  path.split("/").some((part) => EXCLUDED_SEGMENTS.has(part))

const safePath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= 4_096 &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")

const changedPaths = (cwd: string): Effect.Effect<ReadonlyArray<string>, OffloadSnapshotError> =>
  Effect.gen(function* () {
    const [staged, unstaged] = yield* Effect.all([
      git(cwd, ["diff", "--cached", "--name-only", "-z"], false),
      git(cwd, ["diff", "--name-only", "-z"], false)
    ], { concurrency: 2 })
    return [...new Set([...nulPaths(staged), ...nulPaths(unstaged)])].sort()
  })

const validatePaths = (
  cwd: string,
  paths: ReadonlyArray<string>
): Effect.Effect<void, OffloadSnapshotError> =>
  Effect.gen(function* () {
    for (const path of paths) {
      if (!safePath(path) || isExcludedPath(path)) {
        return yield* Effect.fail(
          failure("unsafe-path", `Offload snapshot rejected unsafe path: ${path}`)
        )
      }
      if (isSecretPath(path)) {
        return yield* Effect.fail(
          failure("secret-path", `Offload snapshot rejected secret-prone path: ${path}`)
        )
      }
      const stat = yield* Effect.tryPromise({
        try: () => lstat(resolve(cwd, path)).catch((cause: NodeJS.ErrnoException) =>
          cause.code === "ENOENT" ? null : Promise.reject(cause)
        ),
        catch: () => failure("capture-failed", `Offload snapshot could not inspect: ${path}`)
      })
      if (stat?.isSymbolicLink() || (stat !== null && !stat.isFile())) {
        return yield* Effect.fail(
          failure("unsupported-file", `Offload snapshot supports regular files only: ${path}`)
        )
      }
    }
  })

const validateHeadTree = (
  entries: ReadonlyArray<{ readonly mode: string; readonly path: string }>
): Effect.Effect<void, OffloadSnapshotError> =>
  Effect.gen(function* () {
    for (const entry of entries) {
      if (!safePath(entry.path) || isExcludedPath(entry.path)) {
        return yield* Effect.fail(
          failure("unsafe-path", `Offload snapshot rejected unsafe tracked path: ${entry.path}`)
        )
      }
      if (isSecretPath(entry.path)) {
        return yield* Effect.fail(
          failure("secret-path", `Offload snapshot rejected secret-prone tracked path: ${entry.path}`)
        )
      }
      if (entry.mode === "120000" || entry.mode === "160000") {
        return yield* Effect.fail(
          failure("unsupported-file", `Offload snapshot rejects links and submodules: ${entry.path}`)
        )
      }
    }
  })

const capturePayload = (
  cwd: string,
  maxBytes: number
): Effect.Effect<SnapshotPayload, OffloadSnapshotError> =>
  Effect.gen(function* () {
    const [headSha, headTree, stagedPatch, unstagedPatch, paths] =
      yield* Effect.all([
        git(cwd, ["rev-parse", "--verify", "HEAD"]),
        git(cwd, ["ls-tree", "-rz", "HEAD"], false),
        git(cwd, ["diff", "--binary", "--cached", "--no-ext-diff"], false),
        git(cwd, ["diff", "--binary", "--no-ext-diff"], false),
        changedPaths(cwd)
      ], { concurrency: 5 })
    const entries = treeEntries(headTree)
    yield* validateHeadTree(entries)
    yield* validatePaths(cwd, paths)
    const headArchive = yield* gitBytes(cwd, ["archive", "--format=tar", "HEAD"])
    const uncompressedBytes =
      headArchive.byteLength +
      Buffer.byteLength(stagedPatch) +
      Buffer.byteLength(unstagedPatch)
    if (uncompressedBytes > maxBytes) {
      return yield* Effect.fail(
        failure("too-large", "Offload snapshot exceeds the 64 MiB transfer limit")
      )
    }
    return {
      version: OFFLOAD_COMPUTE_PROTOCOL_VERSION,
      headSha,
      headArchiveBase64: headArchive.toString("base64"),
      headArchiveBytes: headArchive.byteLength,
      headArchiveDigest: sha256(headArchive),
      headFileCount: entries.length,
      stagedPatch,
      unstagedPatch
    }
  })

const payloadFingerprint = (payload: SnapshotPayload): string =>
  sha256(JSON.stringify({
    headSha: payload.headSha,
    headArchiveBytes: payload.headArchiveBytes,
    headArchiveDigest: payload.headArchiveDigest,
    stagedPatch: sha256(payload.stagedPatch),
    unstagedPatch: sha256(payload.unstagedPatch)
  }))

export interface CaptureOffloadSnapshotOptions {
  readonly maxBytes?: number
  readonly afterInitialCapture?: () => Effect.Effect<void>
}

export const captureOffloadSnapshot = (
  workspacePath: string,
  options: CaptureOffloadSnapshotOptions = {}
): Effect.Effect<CapturedOffloadSnapshot, OffloadSnapshotError> =>
  Effect.gen(function* () {
    const cwd = yield* Effect.tryPromise({
      try: () => realpath(workspacePath),
      catch: () => failure("not-git", "Offload Compute requires a Git workspace")
    })
    const maxBytes = Math.min(options.maxBytes ?? OFFLOAD_SNAPSHOT_MAX_BYTES, OFFLOAD_SNAPSHOT_MAX_BYTES)
    const initial = yield* capturePayload(cwd, maxBytes)
    if (options.afterInitialCapture) yield* options.afterInitialCapture()
    const verified = yield* capturePayload(cwd, maxBytes)
    if (payloadFingerprint(initial) !== payloadFingerprint(verified)) {
      return yield* Effect.fail(
        failure("moving-worktree", "Workspace changed while its offload snapshot was captured")
      )
    }
    const encoded = Buffer.from(JSON.stringify(initial))
    if (encoded.byteLength > maxBytes) {
      return yield* Effect.fail(
        failure("too-large", "Offload snapshot exceeds the 64 MiB transfer limit")
      )
    }
    const compressed = gzipSync(encoded, { level: 9 })
    return {
      identity: {
        version: OFFLOAD_COMPUTE_PROTOCOL_VERSION,
        headSha: initial.headSha,
        digest: sha256(compressed),
        bytes: encoded.byteLength
      },
      compressedBytes: compressed,
      fileCount: initial.headFileCount,
      uncompressedBytes: encoded.byteLength
    }
  })

export const uploadOffloadSnapshot = (
  input: UploadOffloadSnapshotInput
): Effect.Effect<UploadedOffloadSnapshot, OffloadSnapshotError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const url = new URL(input.url)
      if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        throw new Error("Snapshot uploads require HTTPS")
      }
      const totalBytes = input.snapshot.compressedBytes.byteLength
      let offset = 0
      input.onProgress?.(0, totalBytes)
      const body = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          if (offset >= totalBytes) {
            controller.close()
            return
          }
          const end = Math.min(offset + UPLOAD_CHUNK_BYTES, totalBytes)
          controller.enqueue(input.snapshot.compressedBytes.slice(offset, end))
          offset = end
          input.onProgress?.(offset, totalBytes)
        }
      })
      const request = new Request(url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${input.grant}`,
          "content-type": "application/vnd.jingler.offload-snapshot+gzip",
          "x-jingler-snapshot-digest": input.snapshot.identity.digest,
          "x-jingler-snapshot-bytes": String(totalBytes)
        },
        body,
        signal,
        duplex: "half"
      } as RequestInit & { readonly duplex: "half" })
      const response = await fetch(request)
      if (!response.ok) throw new Error(`Snapshot upload failed with HTTP ${response.status}`)
      return {
        digest: input.snapshot.identity.digest,
        compressedBytes: input.snapshot.compressedBytes.byteLength
      }
    },
    catch: () => failure("upload-failed", "Offload snapshot upload failed")
  })

/** Effect-owned capture and transfer boundary for read-only Offload Compute inputs. */
export class OffloadSnapshotService extends Effect.Service<OffloadSnapshotService>()(
  "@jingler/OffloadSnapshotService",
  {
    accessors: true,
    sync: () => ({ capture: captureOffloadSnapshot, upload: uploadOffloadSnapshot })
  }
) {}
