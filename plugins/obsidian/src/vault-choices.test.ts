import { mkdtemp, mkdir, open, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { discoverVaults, metadataPath } from "./vault-choices.js"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, open: vi.fn(fs.open) }
})
afterEach(() => vi.resetAllMocks())

it("quietly skips stale, malformed and symlink roots and returns only deduplicated paths", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "obsidian-discovery-")))
  try {
    const vault = join(temp, "Notes")
    await mkdir(vault)
    await symlink(vault, join(temp, "link"))
    const file = join(temp, "obsidian.json")
    expect(await discoverVaults(file)).toEqual([])
    await writeFile(file, "invalid")
    expect(await discoverVaults(file)).toEqual([])
    await writeFile(file, JSON.stringify({ vaults: { a: { path: vault, ts: 123, open: true }, b: { path: vault }, c: { path: join(temp, "missing") }, d: { path: join(temp, "link") }, e: null, f: { path: "relative" } } }))
    expect(await discoverVaults(file)).toEqual([{ name: "Notes", path: vault }])
    await writeFile(file, " ".repeat(262_145))
    expect(await discoverVaults(file)).toEqual([])
  } finally { await rm(temp, { recursive: true, force: true }) }
})

it("reads a valid registry even when the filesystem returns short reads", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "obsidian-short-read-")))
  try {
    const vault = join(temp, "Notes")
    await mkdir(vault)
    const file = join(temp, "obsidian.json")
    await writeFile(file, JSON.stringify({ vaults: { a: { path: vault } } }))
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await fs.open(path, flags, mode)
      const read = handle.read.bind(handle)
      Object.defineProperty(handle, "read", {
        value: (buffer: Buffer, offset: number, length: number, position: number) =>
          read(buffer, offset, Math.min(length, 5), position)
      })
      return handle
    })
    expect(await discoverVaults(file)).toEqual([{ name: "Notes", path: vault }])
  } finally { await rm(temp, { recursive: true, force: true }) }
})

it("uses platform app-data conventions", () => {
  expect(metadataPath("darwin", "/home/test", {})).toBe(join("/home/test", "Library", "Application Support", "obsidian", "obsidian.json"))
  expect(metadataPath("linux", "/home/test", { XDG_CONFIG_HOME: "/config" })).toBe(join("/config", "obsidian", "obsidian.json"))
  expect(metadataPath("win32", "/home/test", { APPDATA: "/roaming" })).toBe(join("/roaming", "obsidian", "obsidian.json"))
})

it("bounds discovery results", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "obsidian-discovery-")))
  try {
    const entries = await Promise.all(Array.from({ length: 55 }, async (_, index) => {
      const path = join(temp, `vault-${index}`)
      await mkdir(path)
      return [String(index), { path }]
    }))
    const file = join(temp, "obsidian.json")
    await writeFile(file, JSON.stringify({ vaults: Object.fromEntries(entries) }))
    expect(await discoverVaults(file)).toHaveLength(50)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
