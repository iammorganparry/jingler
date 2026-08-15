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
    readonly onSpawn?: (pid: number) => void
  }
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer; outputTruncated: boolean; timedOut: boolean }> =>
  new Promise((resolvePromise, reject) => {
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
    child.once("error", reject)
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
      }
    }
    let timedOut = false
    let graceElapsed = false
    let closed: number | null = null
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
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
      setTimeout(() => {
        graceElapsed = true
        kill("SIGKILL")
        if (closed !== null) finish()
      }, 2_000)
    }, options.timeoutMs)
    child.once("close", (code) => {
      closed = code ?? 1
      clearTimeout(timer)
      if (!timedOut || graceElapsed) finish()
    })
    if (options.input !== undefined) {
      if (child.stdin === null) {
        reject(new Error("Owned-device command input pipe was unavailable"))
        return
      }
      child.stdin.end(options.input)
    }
  })

const gitDigest = async (workspace: string): Promise<string> => {
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
    { cwd: workspace, timeoutMs: 30_000, outputBytes: 64 * 1024 }
  )
  if (result.exitCode !== 0) throw new Error("Owned device could not inspect offload source")
  return sha256(result.stdout)
}

const restore = async (
  workspace: string,
  compressed: Buffer,
  expectedBytes: number
): Promise<void> => {
  const decoded = gunzipSync(compressed, { maxOutputLength: expectedBytes })
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
    { cwd: workspace, timeoutMs: 120_000, outputBytes: 64 * 1024 }
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
      outputBytes: 64 * 1024
    })
    if (result.exitCode !== 0) throw new Error("Owned-device Git baseline failed")
  }
  for (const [patch, staged] of [[payload.stagedPatch, true], [payload.unstagedPatch, false]] as const) {
    if (!patch) continue
    const result = await runProcess(
      "git",
      ["apply", "--binary", ...(staged ? ["--index"] : [])],
      { cwd: workspace, timeoutMs: 120_000, outputBytes: 64 * 1024, input: patch }
    )
    if (result.exitCode !== 0) throw new Error("Owned-device snapshot patch failed")
  }
}

const sanitizedEnvironment = (home: string): NodeJS.ProcessEnv => Object.fromEntries(
  ["PATH", "TMPDIR", "LANG", "LC_ALL"].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]
  ).concat([["HOME", home], ["CI", "1"]])
)

const installDependencies = async (workspace: string, home: string): Promise<void> => {
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
      env: sanitizedEnvironment(home)
    })
    if (result.exitCode !== 0) throw new Error("Owned-device dependencies could not be prepared")
    return
  }
}

export const makeOwnedDeviceOffloadExecutor = (root: string) => {
  const jobsRoot = resolve(root, "offload-jobs")
  const active = new Map<string, number>()
  const pathFor = (jobId: string) => join(jobsRoot, jobId)
  const pruneStaleJobs = async (): Promise<void> => {
    await mkdir(jobsRoot, { recursive: true })
    const entries = await readdir(jobsRoot, { withFileTypes: true })
    await Promise.all(entries.flatMap((entry) => {
      if (!entry.isDirectory() || active.has(entry.name)) return []
      const directory = pathFor(entry.name)
      return [stat(join(directory, "metadata.json")).then((metadata) => {
        if (Date.now() - metadata.mtimeMs > 3 * 60 * 60_000) {
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
    },
    chunk: async (input: OwnedOffloadChunk): Promise<void> => {
      const directory = pathFor(input.jobId)
      const metadata = Schema.decodeUnknownSync(OwnedOffloadBegin)(
        JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))
      )
      if (input.index >= metadata.chunkCount) throw new Error("Owned-device chunk index exceeds admission")
      const content = Buffer.from(input.contentBase64, "base64")
      const chunkPath = join(directory, "chunks", String(input.index).padStart(4, "0"))
      try {
        await writeFile(chunkPath, content, { flag: "wx", mode: 0o600 })
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
        if (!content.equals(await readFile(chunkPath))) throw new Error("Owned-device chunk replay changed")
      }
    },
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
      await restore(workspace, compressed, metadata.snapshotBytes)
      const home = join(directory, "home")
      await mkdir(home, { recursive: true })
      await installDependencies(workspace, home)
      const sourceDigest = await gitDigest(workspace)
      const cwd = metadata.command.cwd === "." ? workspace : resolve(workspace, metadata.command.cwd)
      const started = Date.now()
      const command = await runProcess(metadata.command.executable, metadata.command.args, {
        cwd,
        timeoutMs: metadata.limits.timeoutSeconds * 1_000,
        outputBytes: metadata.limits.outputBytes,
        env: sanitizedEnvironment(home),
        onSpawn: (pid) => active.set(jobId, pid)
      })
      active.delete(jobId)
      const result: OwnedOffloadResult = {
        exitCode: command.exitCode,
        stdout: command.stdout.toString("utf8"),
        stderr: command.stderr.toString("utf8"),
        outputTruncated: command.outputTruncated,
        timedOut: command.timedOut,
        sourceMutated: await gitDigest(workspace) !== sourceDigest,
        commandMs: Date.now() - started
      }
      await writeFile(resultPath, JSON.stringify(result), { flag: "wx", mode: 0o600 })
      await rm(workspace, { recursive: true, force: true })
      return result
    },
    cancel: async ({ jobId }: OwnedOffloadExecute): Promise<void> => {
      const pid = active.get(jobId)
      if (pid === undefined) return
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGKILL")
        else process.kill(pid, "SIGKILL")
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
      }
    }
  }
}
