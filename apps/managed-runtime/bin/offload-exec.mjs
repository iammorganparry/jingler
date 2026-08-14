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
    const child = spawn(executable, args, {
      cwd: options.cwd ?? WORKSPACE,
      env: options.env ?? process.env,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.once("error", reject)
    let timedOut = false
    const timer = options.timeout
      ? setTimeout(() => {
          timedOut = true
          child.kill("SIGTERM")
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref()
        }, options.timeout)
      : null
    child.once("close", (code) => {
      if (timer) clearTimeout(timer)
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut
      })
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

const restore = async (snapshotPath) => {
  const payload = JSON.parse(gunzipSync(await readFile(snapshotPath)).toString("utf8"))
  if (
    payload.version !== 1 ||
    typeof payload.headSha !== "string" ||
    typeof payload.headArchiveBase64 !== "string" ||
    typeof payload.headArchiveBytes !== "number" ||
    typeof payload.headArchiveDigest !== "string" ||
    typeof payload.stagedPatch !== "string" ||
    typeof payload.unstagedPatch !== "string"
  ) throw new Error("Snapshot payload is invalid")
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
  await writeFile(resolve(WORKSPACE, ".git/info/exclude"), [
    "**/.cache/", "**/.turbo/", "**/build/", "**/coverage/", "**/dist/", "**/node_modules/", "**/out/"
  ].join("\n"))
  process.stdout.write(await gitStatusDigest())
}

const COMMAND_UID = 65_532
const WRITABLE_OUTPUTS = [".cache", ".turbo", "build", "coverage", "dist", "out"]

const prepareWritableOutputs = async (directory = WORKSPACE) => {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules" || WRITABLE_OUTPUTS.includes(entry.name)) continue
    // biome-ignore lint/performance/noAwaitInLoops: bounded source tree traversal is ordered for hardening.
    await prepareWritableOutputs(resolve(directory, entry.name))
  }
  for (const output of WRITABLE_OUTPUTS) {
    const path = resolve(directory, output)
    // biome-ignore lint/performance/noAwaitInLoops: each output directory is an independent writable mount substitute.
    await mkdir(path, { recursive: true })
    // biome-ignore lint/performance/noAwaitInLoops: ownership must be set before command execution.
    await chown(path, COMMAND_UID, COMMAND_UID)
    // biome-ignore lint/performance/noAwaitInLoops: outputs are private to the unprivileged command user.
    await chmod(path, 0o700)
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
  const result = existsSync(launcher)
    ? await spawnResult(launcher, [input.executable, ...input.args], {
        cwd,
        env: safeEnvironment(),
        timeout: input.timeoutMs
      })
    : await spawnResult(input.executable, input.args, {
        cwd,
        env: safeEnvironment(),
        timeout: input.timeoutMs
      })
  const sourceDigest = await gitStatusDigest()
  const stdout = result.stdout.subarray(0, input.outputBytes).toString("utf8")
  const stderr = result.stderr.subarray(0, input.outputBytes).toString("utf8")
  await writeFile(resultPath, JSON.stringify({
    exitCode: result.exitCode,
    stdout,
    stderr,
    outputTruncated:
      result.stdout.byteLength > input.outputBytes || result.stderr.byteLength > input.outputBytes,
    timedOut: result.timedOut,
    sourceMutated: sourceDigest !== input.sourceDigest,
    commandMs: Date.now() - startedAt
  }), { flag: "wx" })
}

const [mode, first, second] = process.argv.slice(2)
if (mode === "restore" && first) await restore(first)
else if (mode === "manifest") process.stdout.write(await gitStatusDigest())
else if (mode === "run" && first && second) await run(first, second)
else throw new Error("Invalid offload executor invocation")
