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
const issues = [
  ...auditDesktopArchive(listPackage(asarPath)),
  ...auditDeviceBundle(readFileSync(devicePath, "utf8")),
  ...auditRuntimeDependencies(desktopManifest, "desktop"),
  ...auditRuntimeDependencies(deviceManifest, "device agent"),
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
