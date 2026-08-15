import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
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
const deviceEntries = execFileSync("tar", ["-tzf", devicePath], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024
}).split(/\r?\n/u)
const deviceSource = execFileSync(
  "tar",
  ["-xOzf", devicePath, "./jingler-device.mjs"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
)
const requiredDeviceEntries = [
  "./jingler-device.mjs",
  "./runtime-assets/pi-subagent-wrapper.mjs",
  "./runtime-assets/jingler-child-tools.mjs",
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
  ...(existsSync(resolve(resourcesPath, "subagent-runtime", "jingler-child-tools.mjs"))
    ? []
    : ["desktop resources are missing the Jingler child tool bridge"]),
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
