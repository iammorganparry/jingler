import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { gunzipSync } from "node:zlib"
import {
  OwnedDeviceOffloadBegin as OwnedOffloadBegin,
  OwnedDeviceOffloadChunk as OwnedOffloadChunk,
  OwnedDeviceOffloadExecute as OwnedOffloadExecute,
  OwnedDeviceOffloadResult as OwnedOffloadResult
} from "@jingler/core"
import { Schema } from "effect"

const Digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u))

const SnapshotPayload = Schema.Struct({
  version: Schema.Literal(1),
  headSha: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/u)),
  headArchiveBase64: Schema.String.pipe(Schema.maxLength(96 * 1024 * 1024)),
  headArchiveBytes: Schema.Int.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(64 * 1024 * 1024)),
  headArchiveDigest: Digest,
  headFileCount: Schema.Int.pipe(Schema.nonNegative()),
  stagedPatch: Schema.String.pipe(Schema.maxLength(64 * 1024 * 1024)),
  unstagedPatch: Schema.String.pipe(Schema.maxLength(64 * 1024 * 1024))
})

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex")

const runProcess = (
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly timeoutMs: number
    readonly outputBytes: number
    readonly env?: NodeJS.ProcessEnv
    readonly input?: string
    readonly signal?: AbortSignal
    readonly onSpawn?: (pid: number) => void
    readonly onExit?: (pid: number) => void
  }
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer; outputTruncated: boolean; timedOut: boolean }> =>
  new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Owned-device offload was cancelled"))
      return
    }
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    })
    if (child.pid !== undefined) options.onSpawn?.(child.pid)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let retained = 0
    let truncated = false
    const keep = (target: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, options.outputBytes - retained)
      if (remaining > 0) target.push(chunk.subarray(0, remaining))
      retained += Math.min(remaining, chunk.byteLength)
      if (chunk.byteLength > remaining) truncated = true
    }
    if (child.stdout === null || child.stderr === null) {
      reject(new Error("Owned-device command output pipes were unavailable"))
      return
    }
    child.stdout.on("data", (chunk: Buffer) => keep(stdout, chunk))
    child.stderr.on("data", (chunk: Buffer) => keep(stderr, chunk))
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (code !== "ESRCH" && code !== "EPERM") throw cause
      }
    }
    let timedOut = false
    let cancelled = false
    let graceElapsed = false
    let closed: number | null = null
    let settled = false
    let graceTimer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      cancelled = true
      kill("SIGKILL")
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      options.signal?.removeEventListener("abort", onAbort)
      if (child.pid !== undefined) options.onExit?.(child.pid)
    }
    const fail = (cause: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(cause)
    }
    const finish = (): void => {
      if (settled) return
      if (cancelled) {
        fail(new Error("Owned-device offload was cancelled"))
        return
      }
      settled = true
      cleanup()
      resolvePromise({
        exitCode: closed ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        outputTruncated: truncated,
        timedOut
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill("SIGTERM")
      graceTimer = setTimeout(() => {
        graceElapsed = true
        kill("SIGKILL")
        if (closed !== null) finish()
      }, 2_000)
    }, options.timeoutMs)
    child.once("error", fail)
    child.once("close", (code) => {
      closed = code ?? 1
      if (!timedOut || graceElapsed || cancelled) finish()
    })
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const writeCommandInput = () => {
      if (options.input !== undefined) {
        if (child.stdin === null) {
          fail(new Error("Owned-device command input pipe was unavailable"))
          return
        }
        child.stdin.end(options.input)
      }
    }
    writeCommandInput()

  })

interface ProcessControl {
  readonly signal?: AbortSignal
  readonly onSpawn?: (pid: number) => void
  readonly onExit?: (pid: number) => void
}

const ensureNotCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new Error("Owned-device offload was cancelled")
}

const gitDigest = async (
  workspace: string,
  control: ProcessControl = {}
): Promise<string> => {
  const result = await runProcess(
    "git",
    [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude)node_modules",
      ":(exclude).turbo",
      ":(exclude)dist",
      ":(exclude)build",
      ":(exclude)coverage"
    ],
    { cwd: workspace, timeoutMs: 30_000, outputBytes: 64 * 1024, ...control }
  )
  if (result.exitCode !== 0) throw new Error("Owned device could not inspect offload source")
  return sha256(result.stdout)
}

const restore = async (
  workspace: string,
  compressed: Buffer,
  expectedBytes: number,
  control: ProcessControl = {}
): Promise<void> => {
  ensureNotCancelled(control.signal)
  const decoded = gunzipSync(compressed, { maxOutputLength: expectedBytes })
  ensureNotCancelled(control.signal)
  if (decoded.byteLength !== expectedBytes) throw new Error("Owned-device snapshot size mismatch")
  const payload = Schema.decodeUnknownSync(SnapshotPayload)(
    JSON.parse(decoded.toString("utf8")),
    { onExcessProperty: "error" }
  )
  const archive = Buffer.from(payload.headArchiveBase64, "base64")
  if (archive.byteLength !== payload.headArchiveBytes || sha256(archive) !== payload.headArchiveDigest) {
    throw new Error("Owned-device snapshot archive mismatch")
  }
  await rm(workspace, { recursive: true, force: true })
  await mkdir(workspace, { recursive: true })
  const archivePath = join(workspace, ".snapshot.tar")
  await writeFile(archivePath, archive)
  const extracted = await runProcess(
    "tar",
    ["--extract", "--file", archivePath, "--directory", workspace, "--no-same-owner", "--no-same-permissions"],
    { cwd: workspace, timeoutMs: 120_000, outputBytes: 64 * 1024, ...control }
  )
  await rm(archivePath, { force: true })
  if (extracted.exitCode !== 0) throw new Error("Owned-device snapshot extraction failed")
  for (const args of [
    ["init", "--quiet", workspace],
    ["config", "user.name", "Jingler Offload"],
    ["config", "user.email", "offload@invalid"],
    ["add", "--all"],
    ["commit", "--quiet", "--allow-empty", "-m", `snapshot ${payload.headSha}`]
  ]) {
    const result = await runProcess("git", args, {
      cwd: workspace,
      timeoutMs: 120_000,
      outputBytes: 64 * 1024,
      ...control
    })
    if (result.exitCode !== 0) throw new Error("Owned-device Git baseline failed")
  }
  for (const [patch, staged] of [[payload.stagedPatch, true], [payload.unstagedPatch, false]] as const) {
    if (!patch) continue
    const result = await runProcess(
      "git",
      ["apply", "--binary", ...(staged ? ["--index"] : [])],
      { cwd: workspace, timeoutMs: 120_000, outputBytes: 64 * 1024, input: patch, ...control }
    )
    if (result.exitCode !== 0) throw new Error("Owned-device snapshot patch failed")
  }
}

const sanitizedEnvironment = (home: string): NodeJS.ProcessEnv => Object.fromEntries(
  ["PATH", "TMPDIR", "LANG", "LC_ALL"].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]
  ).concat([["HOME", home], ["CI", "1"]])
)

const installDependencies = async (
  workspace: string,
  home: string,
  control: ProcessControl = {}
): Promise<void> => {
  ensureNotCancelled(control.signal)
  const choices: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
    ["pnpm-lock.yaml", "corepack", ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"]],
    ["package-lock.json", "npm", ["ci", "--ignore-scripts"]],
    ["yarn.lock", "corepack", ["yarn", "install", "--immutable", "--mode=skip-builds"]]
  ]
  for (const [lockfile, executable, args] of choices) {
    try {
      await readFile(join(workspace, lockfile))
    } catch {
      continue
    }
    const result = await runProcess(executable, args, {
      cwd: workspace,
      timeoutMs: 10 * 60_000,
      outputBytes: 256 * 1024,
      env: sanitizedEnvironment(home),
      ...control
    })
    if (result.exitCode !== 0) throw new Error("Owned-device dependencies could not be prepared")
    return
  }
}

export const makeOwnedDeviceOffloadExecutor = (
  root: string,
  retentionMs = 3 * 60 * 60_000
) => {
  const jobsRoot = resolve(root, "offload-jobs")
  const active = new Map<string, { readonly controller: AbortController; pid?: number }>()
  const chunkWrites = new Map<string, Promise<void>>()
  const cleanupTimers = new Map<string, NodeJS.Timeout>()
  const pathFor = (jobId: string) => join(jobsRoot, jobId)
  const serializeChunkWrite = async <A>(jobId: string, write: () => Promise<A>): Promise<A> => {
    const prior = chunkWrites.get(jobId) ?? Promise.resolve()
    let release = (): void => undefined
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise
    })
    const tail = prior.then(() => gate)
    chunkWrites.set(jobId, tail)
    await prior
    try {
      return await write()
    } finally {
      release()
      if (chunkWrites.get(jobId) === tail) chunkWrites.delete(jobId)
    }
  }
  const scheduleCleanup = (jobId: string, delayMs = retentionMs): void => {
    const previous = cleanupTimers.get(jobId)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => {
      cleanupTimers.delete(jobId)
      if (active.has(jobId)) {
        scheduleCleanup(jobId, 15 * 60_000)
        return
      }
      void rm(pathFor(jobId), { recursive: true, force: true })
    }, delayMs)
    timer.unref()
    cleanupTimers.set(jobId, timer)
  }
  const pruneStaleJobs = async (): Promise<void> => {
    await mkdir(jobsRoot, { recursive: true })
    const entries = await readdir(jobsRoot, { withFileTypes: true })
    await Promise.all(entries.flatMap((entry) => {
      if (!entry.isDirectory() || active.has(entry.name)) return []
      const directory = pathFor(entry.name)
      return [stat(join(directory, "metadata.json")).then((metadata) => {
        if (Date.now() - metadata.mtimeMs > retentionMs) {
          return rm(directory, { recursive: true, force: true })
        }
      }).catch(() => rm(directory, { recursive: true, force: true }))]
    }))
  }
  return {
    begin: async (input: OwnedOffloadBegin): Promise<void> => {
      await pruneStaleJobs()
      const directory = pathFor(input.jobId)
      await mkdir(join(directory, "chunks"), { recursive: true })
      const metadataPath = join(directory, "metadata.json")
      const encoded = JSON.stringify(input)
      try {
        const existing = await readFile(metadataPath, "utf8")
        if (existing !== encoded) throw new Error("Owned-device offload idempotency conflict")
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
        await writeFile(metadataPath, encoded, { flag: "wx", mode: 0o600 })
      }
      scheduleCleanup(input.jobId)
    },
    chunk: async (input: OwnedOffloadChunk): Promise<void> =>
      serializeChunkWrite(input.jobId, async () => {
        const directory = pathFor(input.jobId)
        const metadata = Schema.decodeUnknownSync(OwnedOffloadBegin)(
          JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))
        )
        if (input.index >= metadata.chunkCount) throw new Error("Owned-device chunk index exceeds admission")
        const content = Buffer.from(input.contentBase64, "base64")
        if (content.byteLength === 0 || content.byteLength > metadata.compressedBytes) {
          throw new Error("Owned-device chunk exceeds admitted snapshot size")
        }
        const chunksDirectory = join(directory, "chunks")
        const chunkName = String(input.index).padStart(4, "0")
        const existingBytes = (await Promise.all(
          (await readdir(chunksDirectory))
            .filter((name) => name !== chunkName)
            .map((name) => stat(join(chunksDirectory, name)).then((entry) => entry.size))
        )).reduce((total, size) => total + size, 0)
        if (existingBytes + content.byteLength > metadata.compressedBytes) {
          throw new Error("Owned-device chunks exceed admitted snapshot size")
        }
        await writeReplaySafeChunk()

        async function writeReplaySafeChunk() {
          const chunkPath = join(chunksDirectory, chunkName)
          try {
            await writeFile(chunkPath, content, { flag: "wx", mode: 0o600 })
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
            if (!content.equals(await readFile(chunkPath))) throw new Error("Owned-device chunk replay changed")
          }
        }
      }),
    execute: async ({ jobId }: OwnedOffloadExecute): Promise<OwnedOffloadResult> => {
      const directory = pathFor(jobId)
      const resultPath = join(directory, "result.json")
      try {
        return Schema.decodeUnknownSync(OwnedOffloadResult)(
          JSON.parse(await readFile(resultPath, "utf8")),
          { onExcessProperty: "error" }
        )
      } catch {
        // The durable result is absent; atomically claim execution below.
      }
      const lock = await open(join(directory, "execution.lock"), "wx", 0o600).catch(() => null)
      if (lock === null) throw new Error("Owned-device offload execution is already running")
      await lock.close()
      const execution = { controller: new AbortController(), pid: undefined as number | undefined }
      active.set(jobId, execution)
      const control: ProcessControl = {
        signal: execution.controller.signal,
        onSpawn: (pid) => {
          execution.pid = pid
        },
        onExit: (pid) => {
          if (execution.pid === pid) execution.pid = undefined
        }
      }
      try {
        const metadata = Schema.decodeUnknownSync(OwnedOffloadBegin)(
          JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))
        )
        const chunks = await Promise.all(Array.from({ length: metadata.chunkCount }, (_, index) =>
          readFile(join(directory, "chunks", String(index).padStart(4, "0")))
        ))
        const compressed = Buffer.concat(chunks)
        if (compressed.byteLength !== metadata.compressedBytes || sha256(compressed) !== metadata.snapshotDigest) {
          throw new Error("Owned-device offload snapshot did not match admission")
        }
        const workspace = join(directory, "workspace")
        await restore(workspace, compressed, metadata.snapshotBytes, control)
        const home = join(directory, "home")
        await mkdir(home, { recursive: true })
        await installDependencies(workspace, home, control)
        const sourceDigest = await gitDigest(workspace, control)
        const cwd = metadata.command.cwd === "." ? workspace : resolve(workspace, metadata.command.cwd)
        const started = Date.now()
        const command = await runProcess(metadata.command.executable, metadata.command.args, {
          cwd,
          timeoutMs: metadata.limits.timeoutSeconds * 1_000,
          outputBytes: metadata.limits.outputBytes,
          env: sanitizedEnvironment(home),
          ...control
        })
        const result: OwnedOffloadResult = {
          exitCode: command.exitCode,
          stdout: command.stdout.toString("utf8"),
          stderr: command.stderr.toString("utf8"),
          outputTruncated: command.outputTruncated,
          timedOut: command.timedOut,
          sourceMutated: await gitDigest(workspace, control) !== sourceDigest,
          commandMs: Date.now() - started
        }
        await writeFile(resultPath, JSON.stringify(result), { flag: "wx", mode: 0o600 })
        await rm(workspace, { recursive: true, force: true })
        return result
      } finally {
        active.delete(jobId)
      }
    },
    cancel: async ({ jobId }: OwnedOffloadExecute): Promise<void> => {
      const execution = active.get(jobId)
      if (execution === undefined) return
      execution.controller.abort()
      execution.pid = undefined
    }
  }
}
