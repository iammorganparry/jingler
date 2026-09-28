/**
 * Launch the packaged desktop app and require it to stay up.
 *
 * A packaged build can pass every unit test and still die at startup — a
 * dependency electron-builder did not ship, a native module built for the wrong
 * ABI, a main-process import that only resolves in dev. This boots the real
 * unpacked app with a throwaway home and profile and fails if it exits inside
 * the window. Linux callers run it under `xvfb-run`.
 *
 * Usage: node smoke-packaged-app.mjs [releaseDir] [seconds]
 */
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const releaseDir = resolve(process.argv[2] ?? "apps/desktop/release")
const seconds = Number(process.argv[3] ?? 20)

/** The unpacked app binary for this platform, whatever arch directory holds it. */
const findExecutable = () => {
  const dirs = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(releaseDir, entry.name))
  const candidates = dirs.flatMap((dir) => {
    if (process.platform === "darwin") return [join(dir, "Jingler.app", "Contents", "MacOS", "Jingler")]
    if (process.platform === "win32") return [join(dir, "Jingler.exe")]
    // electron-builder derives the Linux binary name from productName or the
    // package name, depending on version; accept either.
    return [join(dir, "jingler"), join(dir, "Jingler"), join(dir, "desktop")]
  })
  const found = candidates.find((path) => existsSync(path))
  if (found === undefined) throw new Error(`no packaged Jingler executable under ${releaseDir}`)
  return found
}

const executable = findExecutable()
const scratch = mkdtempSync(join(tmpdir(), "jingler-smoke-"))
const args = [`--user-data-dir=${join(scratch, "profile")}`]
if (process.platform === "linux") args.push("--no-sandbox")

console.log(`smoke: launching ${executable} for ${seconds}s`)
const child = spawn(executable, args, {
  env: { ...process.env, JINGLER_HOME: join(scratch, "home"), ELECTRON_ENABLE_LOGGING: "1" },
  stdio: ["ignore", "pipe", "pipe"]
})
let output = ""
child.stdout.on("data", (chunk) => {
  output += chunk
})
child.stderr.on("data", (chunk) => {
  output += chunk
})

const exited = new Promise((resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })))
const survived = await Promise.race([
  exited.then(() => false),
  new Promise((resolveTimer) => setTimeout(() => resolveTimer(true), seconds * 1000))
])

if (!survived) {
  const { code, signal } = await exited
  console.error(output.slice(-8000))
  console.error(`smoke: the packaged app exited early (code ${code}, signal ${signal})`)
  process.exit(1)
}
child.kill()
console.log(`smoke: the packaged app stayed up for ${seconds}s`)
process.exit(0)
