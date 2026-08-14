import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
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
  const head = await spawnResult("git", ["rev-parse", "HEAD"], { cwd: WORKSPACE })
  if (head.exitCode !== 0 || head.stdout.toString().trim().toLowerCase() !== payload.headSha.toLowerCase()) {
    throw new Error("Snapshot HEAD does not match hydrated workspace")
  }
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
  await Promise.all(payload.files.map(async (file) => {
    if (!safePath(file.path)) throw new Error("Snapshot contains an unsafe path")
    const content = Buffer.from(file.contentBase64, "base64")
    if (content.byteLength !== file.bytes || sha256(content) !== file.digest) {
      throw new Error("Snapshot file digest mismatch")
    }
    const target = insideWorkspace(file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { flag: "wx" })
  }))
  process.stdout.write(await gitStatusDigest())
}

const safeEnvironment = () => Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "COLORTERM"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])
    .concat([["CI", "1"]])
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
    input.outputBytes < 1
  ) throw new Error("Invalid offload command")
  const cwd = input.cwd === "." ? WORKSPACE : insideWorkspace(input.cwd)
  const startedAt = Date.now()
  const result = await spawnResult(input.executable, input.args, {
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
