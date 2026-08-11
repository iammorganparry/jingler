import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const skippedDirectories = new Set(["node_modules", "dist", "out"])

const packageFiles = [join(repoRoot, "package.json")]

const collectPackageFiles = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collectPackageFiles(path)
    else if (entry.name === "package.json") packageFiles.push(path)
  }
}

for (const directory of ["apps", "packages", "plugins"]) {
  collectPackageFiles(join(repoRoot, directory))
}

const packages = packageFiles.map((path) => ({
  path,
  ...JSON.parse(readFileSync(path, "utf8"))
}))
const errors = []

for (const pkg of packages) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(pkg.version)
  if (!match) {
    errors.push(`${pkg.name ?? pkg.path} has an invalid version: ${String(pkg.version)}`)
    continue
  }
  if (Number(match[1]) >= 1) {
    errors.push(`${pkg.name ?? pkg.path} must remain pre-1.0; found ${pkg.version}`)
  }
}

const desktop = packages.find((pkg) => pkg.name === "@jingler/desktop")
if (!desktop) errors.push("@jingler/desktop package is missing")

for (const pkg of packages.filter((candidate) => candidate.name?.startsWith("@jingler/"))) {
  if (desktop && pkg.version !== desktop.version) {
    errors.push(`${pkg.name} is ${pkg.version}; expected ${desktop.version}`)
  }
}

const root = packages.find((pkg) => pkg.name === "jingler")
if (root && desktop && root.version !== desktop.version) {
  errors.push(`root package is ${root.version}; expected ${desktop.version}`)
}

if (errors.length > 0) {
  console.error(["Jingler version policy failed:", ...errors.map((error) => `- ${error}`)].join("\n"))
  process.exitCode = 1
} else {
  console.log(`Jingler version policy OK: ${desktop.version} (pre-1.0)`)
}
