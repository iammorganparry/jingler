import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { listPackage } from "@electron/asar"
import {
  auditDesktopArchive,
  auditDeviceBundle,
  auditRuntimeDependencies
} from "./package-artifact-policy.mjs"

const root = resolve(import.meta.dirname, "../..")
const requiredPath = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  const path = resolve(root, value)
  if (!existsSync(path)) throw new Error(`${name} does not exist: ${path}`)
  return path
}

const asarPath = requiredPath("JINGLER_DESKTOP_ASAR")
const resourcesPath = requiredPath("JINGLER_DESKTOP_RESOURCES")
const devicePath = requiredPath("JINGLER_DEVICE_BUNDLE")
const desktopManifest = JSON.parse(readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"))
const deviceManifest = JSON.parse(readFileSync(resolve(root, "apps/device-agent/package.json"), "utf8"))
// Read the bundle from its own directory by bare file name: GNU tar on the
// Windows runner parses a drive-letter path (`D:\\…`) as `host:file` and fails.
const tarAt = { cwd: dirname(devicePath), encoding: "utf8" }
const deviceFile = basename(devicePath)
const packagedWorker = resolve(
  resourcesPath,
  "subagent-runtime",
  "jingler-subagent-process-worker.mjs"
)
const deviceEntries = execFileSync("tar", ["-tzf", deviceFile], {
  ...tarAt,
  maxBuffer: 16 * 1024 * 1024
}).split(/\r?\n/u)
const deviceSource = execFileSync(
  "tar",
  ["-xOzf", deviceFile, "./jingler-device.mjs"],
  { ...tarAt, maxBuffer: 64 * 1024 * 1024 }
)
const auditPackagedWorker = () => {
  if (!existsSync(packagedWorker)) return []
  const isolatedRoot = mkdtempSync(join(tmpdir(), "jingler-worker-smoke-"))
  const isolatedWorker = join(isolatedRoot, "worker.mjs")
  copyFileSync(packagedWorker, isolatedWorker)
  try {
    const output = execFileSync(process.execPath, [isolatedWorker], {
      encoding: "utf8",
      input: "{}\n",
      timeout: 10_000
    }).trim()
    const message = JSON.parse(output)
    return message.type === "fatal" && message.error === "Child session is not initialized"
      ? []
      : ["desktop subagent process worker returned an unexpected smoke response"]
  } catch (cause) {
    return [`desktop subagent process worker failed its smoke run: ${cause.message}`]
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true })
  }
}

const requiredDeviceEntries = [
  "./jingler-device.mjs",
  "./runtime-assets/jingler-child-tools.mjs",
  "./runtime-assets/jingler-claude-cli-provider.mjs",
  "./node_modules/@dietrichgebert/ponytail/package.json",
  "./node_modules/@dietrichgebert/ponytail/pi-extension/index.js",
  "./node_modules/@dietrichgebert/ponytail/skills/ponytail/SKILL.md",
  "./node_modules/@dietrichgebert/ponytail/skills/ponytail-review/SKILL.md",
  "./node_modules/@dietrichgebert/ponytail/skills/ponytail-audit/SKILL.md",
  "./node_modules/@dietrichgebert/ponytail/skills/ponytail-debt/SKILL.md",
  "./node_modules/@dietrichgebert/ponytail/skills/ponytail-gain/SKILL.md",
  "./node_modules/@dietrichgebert/ponytail/skills/ponytail-help/SKILL.md",
  "./node_modules/pi-subagents/index.ts",
  "./node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
]
const issues = [
  ...auditDesktopArchive(listPackage(asarPath)),
  ...auditDeviceBundle(deviceSource),
  ...requiredDeviceEntries.flatMap((entry) =>
    deviceEntries.includes(entry) ? [] : [`device runtime archive is missing ${entry}`]
  ),
  ...auditRuntimeDependencies(desktopManifest, "desktop"),
  ...auditRuntimeDependencies(deviceManifest, "device agent"),
  ...auditPackagedWorker(),
  ...(existsSync(resolve(resourcesPath, "subagent-runtime", "jingler-child-tools.mjs"))
    ? []
    : ["desktop resources are missing the Jingler child tool bridge"]),
  ...(existsSync(resolve(resourcesPath, "subagent-runtime", "jingler-claude-cli-provider.mjs"))
    ? []
    : ["desktop resources are missing the Claude CLI child provider"]),
  ...(existsSync(packagedWorker)
    ? []
    : ["desktop resources are missing the bundled subagent process worker"]),
  ...(existsSync(resolve(resourcesPath, "THIRD-PARTY-LICENSES"))
    ? []
    : ["desktop resources are missing THIRD-PARTY-LICENSES"])
]

if (issues.length > 0) {
  process.stderr.write(`${issues.join("\n")}\n`)
  process.exitCode = 1
} else {
  process.stdout.write("desktop and device artifacts satisfy runtime packaging policy\n")
}
