import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, chown, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { spawn } from "node:child_process"
import { gunzipSync } from "node:zlib"

const WORKSPACE = process.env.JINGLER_OFFLOAD_WORKSPACE ?? "/workspace"
const EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u
const hasControl = (value) => Array.from(value).some((character) => {
  const point = character.codePointAt(0) ?? 0
  return point < 0x20 || point === 0x7f
})

const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const safePath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  path.length <= 4096 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path.split("/").every((part) => part && part !== "." && part !== "..")

const insideWorkspace = (path) => {
  const absolute = resolve(WORKSPACE, path)
  const inside = relative(WORKSPACE, absolute)
  if (inside === ".." || inside.startsWith(`..${sep}`)) throw new Error("Path escapes workspace")
  return absolute
}

const spawnResult = (executable, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const detached = process.platform !== "win32"
    const child = spawn(executable, args, {
      cwd: options.cwd ?? WORKSPACE,
      env: options.env ?? process.env,
      detached,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    })
    const outputLimit = options.outputBytes ?? 4 * 1024 * 1024
    const stdout = []
    const stderr = []
    let retainedBytes = 0
    let outputTruncated = false
    const retain = (chunks, chunk, bytes) => {
      const remaining = Math.max(0, outputLimit - bytes)
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      if (chunk.byteLength > remaining) outputTruncated = true
      return bytes + Math.min(chunk.byteLength, remaining)
    }
    child.stdout.on("data", (chunk) => { retainedBytes = retain(stdout, chunk, retainedBytes) })
    child.stderr.on("data", (chunk) => { retainedBytes = retain(stderr, chunk, retainedBytes) })
    child.once("error", reject)
    const killGroup = (signal) => {
      if (child.pid === undefined) return
      try {
        if (detached) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (cause) {
        if (cause?.code !== "ESRCH") throw cause
      }
    }
    let timedOut = false
    let graceElapsed = false
    let closeCode = null
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolvePromise({
        exitCode: closeCode ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        outputTruncated,
        timedOut
      })
    }
    const timer = options.timeout
      ? setTimeout(() => {
          timedOut = true
          killGroup("SIGTERM")
          setTimeout(() => {
            graceElapsed = true
            killGroup("SIGKILL")
            if (closeCode !== null) finish()
          }, 2_000)
        }, options.timeout)
      : null
    child.once("close", (code) => {
      closeCode = code ?? 1
      if (timer) clearTimeout(timer)
      if (!timedOut || graceElapsed) finish()
    })
    if (options.input !== undefined) child.stdin.end(options.input)
  })

const gitStatusDigest = async () => {
  const status = await spawnResult(
    "git",
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    { cwd: WORKSPACE }
  )
  if (status.exitCode !== 0) throw new Error("Could not inspect workspace state")
  return sha256(status.stdout)
}

const restorePatches = async (payload) => {
  for (const [patch, staged] of [
    [payload.stagedPatch, true],
    [payload.unstagedPatch, false]
  ]) {
    if (!patch) continue
    // biome-ignore lint/performance/noAwaitInLoops: staged patch must precede unstaged patch.
    const applied = await spawnResult(
      "git",
      ["apply", "--binary", ...(staged ? ["--index"] : [])],
      { cwd: WORKSPACE, input: patch }
    )
    if (applied.exitCode !== 0) throw new Error("Snapshot patch could not be restored")
  }
}

const validateCommandInput = (input) => {
  if (
    typeof input.executable !== "string" ||
    !EXECUTABLE.test(input.executable) ||
    !Array.isArray(input.args) ||
    input.args.length > 128 ||
    input.args.some((arg) => typeof arg !== "string" || arg.length > 4096 || hasControl(arg)) ||
    !safePath(input.cwd === "." ? "workspace" : input.cwd) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    !Number.isSafeInteger(input.outputBytes) ||
    input.outputBytes < 1 ||
    typeof input.startAllowed !== "boolean"
  ) throw new Error("Invalid offload command")
}

const validateSnapshotPayload = (payload) => {
  if (
    payload.version !== 1 ||
    typeof payload.headSha !== "string" ||
    typeof payload.headArchiveBase64 !== "string" ||
    typeof payload.headArchiveBytes !== "number" ||
    typeof payload.headArchiveDigest !== "string" ||
    typeof payload.stagedPatch !== "string" ||
    typeof payload.unstagedPatch !== "string"
  ) throw new Error("Snapshot payload is invalid")
}

const restore = async (snapshotPath, admittedBytes) => {
  if (!Number.isSafeInteger(admittedBytes) || admittedBytes < 1 || admittedBytes > 64 * 1024 * 1024) {
    throw new Error("Snapshot size admission is invalid")
  }
  const compressed = await readFile(snapshotPath)
  const decoded = gunzipSync(compressed, { maxOutputLength: admittedBytes })
  if (decoded.byteLength !== admittedBytes) throw new Error("Snapshot size does not match admission")
  const payload = JSON.parse(decoded.toString("utf8"))
  validateSnapshotPayload(payload)
  const archive = Buffer.from(payload.headArchiveBase64, "base64")
  if (archive.byteLength !== payload.headArchiveBytes || sha256(archive) !== payload.headArchiveDigest) {
    throw new Error("Snapshot HEAD archive digest mismatch")
  }
  await mkdir(WORKSPACE, { recursive: true })
  for (const entry of await readdir(WORKSPACE)) {
    // biome-ignore lint/performance/noAwaitInLoops: workspace must be cleared before extraction.
    await rm(resolve(WORKSPACE, entry), { recursive: true, force: true })
  }
  const archivePath = `${snapshotPath}.tar`
  await writeFile(archivePath, archive, { flag: "wx" })
  const extracted = await spawnResult(
    "tar",
    ["--extract", "--file", archivePath, "--directory", WORKSPACE, "--no-same-owner", "--no-same-permissions"]
  )
  await rm(archivePath, { force: true })
  if (extracted.exitCode !== 0) throw new Error("Snapshot HEAD archive could not be restored")
  const initialized = await spawnResult("git", ["init", "--quiet", WORKSPACE])
  if (initialized.exitCode !== 0) throw new Error("Snapshot Git baseline could not be initialized")
  await spawnResult("git", ["config", "user.name", "Jingler Offload"], { cwd: WORKSPACE })
  await spawnResult("git", ["config", "user.email", "offload@invalid"], { cwd: WORKSPACE })
  const added = await spawnResult("git", ["add", "--all"], { cwd: WORKSPACE })
  const committed = added.exitCode === 0
    ? await spawnResult("git", ["commit", "--quiet", "--allow-empty", "-m", `snapshot ${payload.headSha}`], { cwd: WORKSPACE })
    : added
  if (committed.exitCode !== 0) throw new Error("Snapshot Git baseline could not be created")
  await restorePatches(payload)
  await writeFile(resolve(WORKSPACE, ".git/info/exclude"), [
    "**/.cache/", "**/.turbo/", "**/build/", "**/coverage/", "**/dist/", "**/node_modules/", "**/out/"
  ].join("\n"))
  process.stdout.write(await gitStatusDigest())
}

const COMMAND_UID = 65_532
const WRITABLE_OUTPUTS = [".cache", ".turbo", "build", "coverage", "dist", "out"]

const MAX_PROJECT_ROOTS = 512
const MAX_SCANNED_DIRECTORIES = 10_000

const discoverProjectRoots = async () => {
  const roots = []
  const pending = [WORKSPACE]
  let scanned = 0
  while (pending.length > 0) {
    const directory = pending.pop()
    scanned += 1
    if (scanned > MAX_SCANNED_DIRECTORIES) {
      throw new Error("Repository has too many directories to harden safely")
    }
    // biome-ignore lint/performance/noAwaitInLoops: traversal is deliberately bounded.
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      roots.push(directory)
      if (roots.length > MAX_PROJECT_ROOTS) {
        throw new Error("Repository has too many package roots to harden safely")
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules" || WRITABLE_OUTPUTS.includes(entry.name)) continue
      pending.push(resolve(directory, entry.name))
    }
  }
  return roots.length === 0 ? [WORKSPACE] : roots
}

const prepareWritableOutputs = async () => {
  for (const directory of await discoverProjectRoots()) {
    for (const output of WRITABLE_OUTPUTS) {
      const path = resolve(directory, output)
      // biome-ignore lint/performance/noAwaitInLoops: bounded package output roots are hardened in order.
      await mkdir(path, { recursive: true })
      // biome-ignore lint/performance/noAwaitInLoops: ownership must be set before command execution.
      await chown(path, COMMAND_UID, COMMAND_UID)
      // biome-ignore lint/performance/noAwaitInLoops: outputs are private to the unprivileged command user.
      await chmod(path, 0o700)
    }
  }
}

const hardenWorkspace = async () => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return
  const locked = await spawnResult("chmod", ["-R", "a-w", WORKSPACE])
  if (locked.exitCode !== 0) throw new Error("Workspace could not be made read-only")
  const home = "/tmp/jingler-offload-home"
  await rm(home, { recursive: true, force: true })
  await mkdir(home, { recursive: true })
  await chown(home, COMMAND_UID, COMMAND_UID)
  await chmod(home, 0o700)
  await prepareWritableOutputs()
}

const safeEnvironment = () => Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "COLORTERM"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])
    .concat([["CI", "1"], ["HOME", "/tmp/jingler-offload-home"]])
)

const run = async (commandPath, resultPath) => {
  try {
    await readFile(resultPath)
    return
  } catch {
    // The durable result marker is absent; this execution owns the command.
  }
  const input = JSON.parse(await readFile(commandPath, "utf8"))
  validateCommandInput(input)
  const lockPath = `${resultPath}.lock`
  try {
    await writeFile(lockPath, String(Date.now()), { flag: "wx", mode: 0o400 })
  } catch {
    const deadline = Date.now() + input.timeoutMs + 10_000
    while (Date.now() < deadline) {
      try {
        await readFile(resultPath)
        return
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
      }
    }
    throw new Error("Existing offload command did not publish a terminal result")
  }
  if (!input.startAllowed) {
    throw new Error("Offload execution ownership was lost; refusing duplicate execution")
  }
  await hardenWorkspace()
  const cwd = input.cwd === "." ? WORKSPACE : insideWorkspace(input.cwd)
  const startedAt = Date.now()
  const launcher = process.env.JINGLER_OFFLOAD_LAUNCHER ?? "/opt/jingler/offload-launch"
  if (!existsSync(launcher)) {
    throw new Error("Offload security launcher is unavailable; refusing unisolated execution")
  }
  const result = await spawnResult(launcher, [input.executable, ...input.args], {
    cwd,
    env: safeEnvironment(),
    timeout: input.timeoutMs,
    outputBytes: input.outputBytes
  })
  const sourceDigest = await gitStatusDigest()
  const stdout = result.stdout.toString("utf8")
  const stderr = result.stderr.toString("utf8")
  await writeFile(resultPath, JSON.stringify({
    exitCode: result.exitCode,
    stdout,
    stderr,
    outputTruncated: result.outputTruncated,
    timedOut: result.timedOut,
    sourceMutated: sourceDigest !== input.sourceDigest,
    commandMs: Date.now() - startedAt
  }), { flag: "wx" })
}

const [mode, first, second] = process.argv.slice(2)
if (mode === "restore" && first && second) await restore(first, Number(second))
else if (mode === "manifest") process.stdout.write(await gitStatusDigest())
else if (mode === "run" && first && second) await run(first, second)
else throw new Error("Invalid offload executor invocation")
