/**
 * Merge per-architecture electron-builder update manifests into one.
 *
 * Each macOS / Windows build job writes its own `latest-mac.yml` / `latest.yml`
 * (or `nightly-mac.yml` / `nightly.yml`) listing only its architecture's files.
 * electron-updater reads ONE manifest per channel and picks the file for its
 * own arch from `files:`, so the published manifest must list every arch.
 *
 * Usage: node merge-update-manifests.mjs <out> <in...>
 *
 * The manifest shape is electron-builder's own, so this stays a line-level
 * merge rather than a YAML round-trip that could reorder or requote fields.
 */
import { readFileSync, writeFileSync } from "node:fs"

const field = (text, name) => {
  const match = new RegExp(`^${name}: (.*)$`, "m").exec(text)
  return match === null ? null : match[1].trim()
}

/** The `files:` entries of a manifest, as their raw indented lines. */
const fileEntries = (text) => {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line === "files:")
  if (start === -1) throw new Error("update manifest has no files: list")
  const entries = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break
    if (line.startsWith("  - ")) entries.push([line])
    else entries.at(-1)?.push(line)
  }
  return entries
}

export const mergeUpdateManifests = (manifests) => {
  if (manifests.length === 0) throw new Error("no update manifests to merge")
  const [first, ...rest] = manifests
  const version = field(first, "version")
  for (const other of rest) {
    if (field(other, "version") !== version) {
      throw new Error(`update manifests disagree on version: ${version} vs ${field(other, "version")}`)
    }
  }
  const seen = new Set()
  const entries = manifests.flatMap(fileEntries).filter((entry) => {
    const url = entry[0]
    if (seen.has(url)) return false
    seen.add(url)
    return true
  })
  const lines = first.split("\n")
  const start = lines.indexOf("files:")
  let end = start + 1
  while (end < lines.length && lines[end].startsWith("  ")) end += 1
  return [...lines.slice(0, start + 1), ...entries.flat(), ...lines.slice(end)].join("\n")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, ...inputs] = process.argv.slice(2)
  if (out === undefined || inputs.length === 0) {
    console.error("usage: merge-update-manifests.mjs <out> <in...>")
    process.exit(2)
  }
  const merged = mergeUpdateManifests(inputs.map((path) => readFileSync(path, "utf8")))
  writeFileSync(out, merged)
  console.log(`merged ${inputs.length} manifests into ${out} (${fileEntries(merged).length} files)`)
}
