import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { validateRoot } from "./vault.js"

export interface VaultChoice { name: string; path: string }
export function metadataPath(platform = process.platform, home = homedir(), env = process.env): string {
  const base = platform === "darwin" ? join(home, "Library", "Application Support")
    : platform === "win32" ? env.APPDATA || join(home, "AppData", "Roaming")
    : env.XDG_CONFIG_HOME || join(home, ".config")
  return join(base, "obsidian", "obsidian.json")
}

// Best-effort reading of private desktop metadata, not an official Obsidian API.
// Never return registry ids, timestamps, open flags, or metadata errors.
export async function discoverVaults(file = metadataPath()): Promise<VaultChoice[]> {
  try {
    const raw = await readRegistry(file)
    if (!raw || typeof raw !== "object" || !("vaults" in raw)) return []
    const vaults = raw.vaults
    if (!vaults || typeof vaults !== "object" || Array.isArray(vaults)) return []
    const choices = new Map<string, VaultChoice>()
    let resultBytes = 0
    for (const entry of Object.values(vaults).slice(0, 200)) {
      if (!isVaultEntry(entry)) continue
      try {
        const path = await validateRoot(entry.path)
        if (choices.has(path)) continue
        const choice = { name: basename(path), path }
        resultBytes += JSON.stringify(choice).length
        if (resultBytes > 30_000 || choices.size >= 50) break
        choices.set(path, choice)
      } catch { /* Stale or unsafe roots are normal. */ }
    }
    return [...choices.values()].sort((a, b) => a.path.localeCompare(b.path))
  } catch { return [] }
}

async function readRegistry(file: string): Promise<unknown> {
    if (!isAbsolute(file)) return null
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let raw: unknown
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 262_144) return null
      const bytes = Buffer.alloc(262_145)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 262_144) return null
      raw = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))
    } finally { await handle.close() }
    return raw
}

function isVaultEntry(entry: unknown): entry is { path: string } {
  return !!entry && typeof entry === "object" && "path" in entry && typeof entry.path === "string" && entry.path.length <= 4096
}
