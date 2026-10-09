import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentToolDefinition, SessionSnapshot } from "@jingler/plugin-sdk/host"
import { afterEach, expect, it, vi } from "vitest"
import { activateWithContext } from "./main.js"
import { readNote, writeNote } from "./vault.js"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, open: vi.fn(fs.open) }
})
vi.mock("./vault.js", async (importOriginal) => {
  const vault = await importOriginal<typeof import("./vault.js")>()
  return { ...vault, writeNote: vi.fn(vault.writeNote) }
})
afterEach(() => vi.resetAllMocks())

it("invalidates a queued write when its session changes vaults", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "obsidian-queue-")))
  const root = join(home, "old")
  const next = join(home, "new")
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let stagingStarted!: () => void
  const staging = new Promise<void>((resolve) => { stagingStarted = resolve })
  let first: Promise<unknown> | undefined
  let queued: Promise<unknown> | undefined
  try {
    await mkdir(root); await mkdir(next)
    await writeFile(join(root, "note.md"), "original")
    await writeFile(join(root, "blocker.md"), "blocker")
    const values = new Map<string, unknown>()
    const commands = new Map<string, (input?: unknown) => unknown>()
    let tools: readonly AgentToolDefinition[] = []
    // SAFETY: Only id/repo are consumed from this session snapshot.
    const snapshot = { id: "session", repo: "repo" } as SessionSnapshot
    await activateWithContext({
      sessions: { get: async () => snapshot },
      storage: {
        keys: async () => [...values.keys()],
        // SAFETY: Mirrors the caller-owned generic storage contract.
        get: async <T>(key: string) => values.get(key) as T | undefined,
        set: async (key, value) => { values.set(key, value) },
        delete: async (key) => { values.delete(key) }
      },
      subscriptions: [],
      commands: { register: (id, handler) => { commands.set(id, handler); return { dispose() {} } } },
      agentTools: { registerToolset: (set) => { tools = set.tools; return { dispose() {} } } }
    })
    await commands.get("obsidian.configure")!({ sessionId: "session", root })
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let blockedOnce = false
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const file = await fs.open(path, flags, mode)
      if (String(path).endsWith(".tmp") && !blockedOnce) {
        blockedOnce = true
        vi.spyOn(file, "sync").mockImplementation(async () => { stagingStarted(); await blocked })
      }
      return file
    })
    const blocker = await readNote(root, "blocker.md")
    first = writeNote(root, blocker.path, "finished", blocker.revision)
    await staging
    const note = await readNote(root, "note.md")
    queued = Promise.resolve(tools.find((tool) => tool.id === "obsidian_write")!.execute({ path: note.path, content: "unwanted", revision: note.revision, vault: root }, {
      signal: new AbortController().signal, session: { id: "session", repository: { name: "repo", path: "/repo" } }
    }))
    // Observe that the host captured the old root and submitted its write to the queue.
    await vi.waitFor(() => expect(writeNote).toHaveBeenCalledTimes(2))
    await commands.get("obsidian.configure")!({ sessionId: "session", root: next })
    const rejected = expect(queued).rejects.toThrow("Vault changed")
    release()
    await first
    await rejected
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("original")
  } finally {
    release()
    await Promise.allSettled([first, queued])
    await rm(home, { recursive: true, force: true })
  }
})
