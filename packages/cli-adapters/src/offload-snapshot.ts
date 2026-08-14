import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
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

interface SnapshotFile {
  readonly path: string
  readonly contentBase64: string
  readonly bytes: number
  readonly digest: string
}

interface SnapshotPayload {
  readonly version: 1
  readonly headSha: string
  readonly stagedPatch: string
  readonly unstagedPatch: string
  readonly files: ReadonlyArray<SnapshotFile>
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

const nulPaths = (value: string): ReadonlyArray<string> =>
  value.length === 0 ? [] : value.split("\0").filter(Boolean).sort()

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
    const [staged, unstaged, untracked] = yield* Effect.all([
      git(cwd, ["diff", "--cached", "--name-only", "-z"], false),
      git(cwd, ["diff", "--name-only", "-z"], false),
      git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], false)
    ], { concurrency: 3 })
    return [...new Set([...nulPaths(staged), ...nulPaths(unstaged), ...nulPaths(untracked)])]
      .sort()
  })

const validatePaths = (
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
    }
  })

const readUntrackedFiles = (
  cwd: string,
  paths: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<SnapshotFile>, OffloadSnapshotError> =>
  Effect.forEach(
    paths,
    (path) =>
      Effect.tryPromise({
        try: async () => {
          const absolute = resolve(cwd, path)
          const inside = relative(cwd, absolute)
          if (inside === ".." || inside.startsWith(`..${sep}`)) {
            throw failure("unsafe-path", `Offload snapshot path escapes its repository: ${path}`)
          }
          const stat = await lstat(absolute)
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw failure("unsupported-file", `Offload snapshot supports regular files only: ${path}`)
          }
          const content = await readFile(absolute)
          return {
            path,
            contentBase64: content.toString("base64"),
            bytes: content.byteLength,
            digest: sha256(content)
          }
        },
        catch: (cause) =>
          cause instanceof OffloadSnapshotError
            ? cause
            : failure("capture-failed", `Offload snapshot could not read: ${path}`)
      }),
    { concurrency: 4 }
  )

const capturePayload = (
  cwd: string,
  maxBytes: number
): Effect.Effect<SnapshotPayload, OffloadSnapshotError> =>
  Effect.gen(function* () {
    const [headSha, stagedPatch, unstagedPatch, untrackedText, paths] =
      yield* Effect.all([
        git(cwd, ["rev-parse", "--verify", "HEAD"]),
        git(cwd, ["diff", "--binary", "--cached", "--no-ext-diff"], false),
        git(cwd, ["diff", "--binary", "--no-ext-diff"], false),
        git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], false),
        changedPaths(cwd)
      ], { concurrency: 5 })
    yield* validatePaths(paths)
    const files = yield* readUntrackedFiles(cwd, nulPaths(untrackedText))
    const uncompressedBytes =
      Buffer.byteLength(stagedPatch) +
      Buffer.byteLength(unstagedPatch) +
      files.reduce((total, file) => total + file.bytes, 0)
    if (uncompressedBytes > maxBytes) {
      return yield* Effect.fail(
        failure("too-large", "Offload snapshot exceeds the 64 MiB transfer limit")
      )
    }
    return {
      version: OFFLOAD_COMPUTE_PROTOCOL_VERSION,
      headSha,
      stagedPatch,
      unstagedPatch,
      files
    }
  })

const payloadFingerprint = (payload: SnapshotPayload): string =>
  sha256(JSON.stringify({
    headSha: payload.headSha,
    stagedPatch: sha256(payload.stagedPatch),
    unstagedPatch: sha256(payload.unstagedPatch),
    files: payload.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      digest: file.digest
    }))
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
      fileCount: initial.files.length,
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
