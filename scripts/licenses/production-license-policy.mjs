import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export const ALLOWED_PRODUCTION_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unlicense"
])

const REVIEWED_LICENSE_OVERRIDES = new Map([
  ["khroma@2.1.0", "MIT"]
])

export const PROHIBITED_PRODUCTION_LICENSES = new Set([
  "AGPL-1.0",
  "AGPL-3.0",
  "BUSL-1.1",
  "GPL-1.0",
  "GPL-2.0",
  "GPL-3.0",
  "SSPL-1.0"
])

const OR_OPERATOR = /\s+OR\s+/i
const AND_OPERATOR = /\s+AND\s+/i
const PARENTHESES = /[()]/g

const manifestAt = (path) => JSON.parse(readFileSync(path, "utf8"))

const workspaceManifests = (root) => {
  const manifests = []
  const visit = (directory) => {
    if (!existsSync(directory)) return
    const packageFile = join(directory, "package.json")
    if (existsSync(packageFile)) {
      manifests.push({ path: packageFile, manifest: manifestAt(packageFile) })
      return
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        visit(join(directory, entry.name))
      }
    }
  }
  for (const name of ["apps", "packages", "plugins"]) visit(join(root, name))
  return manifests
}

const resolveDependency = (name, importer, root, workspaces) => {
  const workspace = workspaces.get(name)
  if (workspace) return workspace.path

  let cursor = importer
  while (cursor.startsWith(root)) {
    const candidate = join(cursor, "node_modules", name, "package.json")
    if (existsSync(candidate)) return candidate
    if (cursor === root) break
    cursor = dirname(cursor)
  }
  return null
}

const dependencyNames = (manifest) => [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {})
]

const normalizeLicense = (value) => value.toLowerCase() === "apache-2.0"
  ? "Apache-2.0"
  : value

const classifyLicense = (license) => {
  if (typeof license !== "string" || license.trim().length === 0) return "unknown"
  const alternatives = license
    .replace(PARENTHESES, " ")
    .split(OR_OPERATOR)
    .map((alternative) => alternative
      .split(AND_OPERATOR)
      .map((value) => normalizeLicense(value.trim()))
      .filter(Boolean))
  if (alternatives.some((atoms) =>
    atoms.every((atom) => ALLOWED_PRODUCTION_LICENSES.has(atom))
  )) return "allowed"
  if (alternatives.flat().some((atom) => PROHIBITED_PRODUCTION_LICENSES.has(atom))) {
    return "prohibited"
  }
  return "unknown"
}

const packageEvidence = (manifest, path) => {
  const packageId = `${manifest.name ?? "(unnamed)"}@${manifest.version ?? "(unknown)"}`
  const license = REVIEWED_LICENSE_OVERRIDES.get(packageId) ?? manifest.license ?? null
  const classification = classifyLicense(license)
  return {
    record: {
      name: manifest.name ?? "(unnamed)",
      version: manifest.version ?? "(unknown)",
      license,
      classification,
      path
    },
    issue: classification === "allowed"
      ? null
      : `${packageId} has ${classification} license ${license ?? "(missing)"}`
  }
}

const resolvedDependencies = (manifest, path, root, workspaces) => {
  const paths = []
  const issues = []
  for (const dependency of dependencyNames(manifest)) {
    const dependencyPath = resolveDependency(dependency, dirname(path), root, workspaces)
    if (dependencyPath !== null) {
      paths.push(dependencyPath)
    } else if (manifest.optionalDependencies?.[dependency] === undefined) {
      issues.push(`${manifest.name ?? path} cannot resolve production dependency ${dependency}`)
    }
  }
  return { paths, issues }
}

export const inspectProductionLicenses = (root) => {
  const workspaceEntries = workspaceManifests(root)
  const workspaces = new Map(
    workspaceEntries
      .filter(({ manifest }) => typeof manifest.name === "string")
      .map((entry) => [entry.manifest.name, entry])
  )
  const pending = [...workspaceEntries.map(({ path }) => path)]
  const visited = new Set()
  const packages = []
  const issues = []

  while (pending.length > 0) {
    const path = resolve(pending.pop())
    if (visited.has(path)) continue
    visited.add(path)
    const manifest = manifestAt(path)
    const workspace = workspaces.has(manifest.name)
    if (!workspace) {
      const evidence = packageEvidence(manifest, path)
      packages.push(evidence.record)
      if (evidence.issue !== null) issues.push(evidence.issue)
    }
    const dependencies = resolvedDependencies(manifest, path, root, workspaces)
    pending.push(...dependencies.paths)
    issues.push(...dependencies.issues)
  }

  return {
    packages: packages.sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)
    ),
    issues: [...new Set(issues)].sort()
  }
}

export const piAttributionIssues = (text, packages) => {
  const piPackages = packages.filter(({ name }) =>
    name === "@earendil-works/pi-ai" || name === "@earendil-works/pi-coding-agent"
  )
  if (piPackages.length === 0) return ["the production graph does not include pi"]
  return [
    ...piPackages.flatMap(({ name, version }) =>
      text.includes(`${name}@${version}`) ? [] : [`missing attribution for ${name}@${version}`]
    ),
    ...(text.includes("Copyright (c) 2025 Mario Zechner")
      ? []
      : ["missing pi copyright notice"]),
    ...(text.includes("MIT License") ? [] : ["missing pi MIT license text"])
  ]
}
