import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentToolDefinition, SessionSnapshot } from "@jingler/plugin-sdk/host"
import { expect, it } from "vitest"
import { activateWithContext, storageKey } from "./main.js"
import { readNote } from "./vault.js"

it("persists validated session configuration and isolates agent routing", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "obsidian-host-")))
  try {
    await writeFile(join(root, "note.md"), "original")
    const values = new Map<string, unknown>()
    const commands = new Map<string, (input?: unknown) => unknown>()
    let tools: readonly AgentToolDefinition[] = []
    // SAFETY: Only these session fields are consumed by the plugin host.
    const snapshot = { id: "session", repo: "repo" } as SessionSnapshot
    await activateWithContext({
      sessions: { get: async (id) => id === "session" ? snapshot : undefined },
      storage: {
        keys: async () => [...values.keys()],
        // SAFETY: Mirrors PluginStorage's caller-owned generic read contract.
        get: async <T>(key: string) => values.get(key) as T | undefined,
        set: async (key, value) => { values.set(key, value) },
        delete: async (key) => { values.delete(key) }
      },
      subscriptions: [],
      commands: { register: (id, handler) => { commands.set(id, handler); return { dispose() {} } } },
      agentTools: { registerToolset: (set) => { tools = set.tools; return { dispose() {} } } }
    })
    const configure = commands.get("obsidian.configure")!
    await expect(configure({ sessionId: "missing", root })).rejects.toThrow("Unknown session")
    await expect(configure({ sessionId: "session", root: "relative" })).rejects.toThrow()
    expect(values.size).toBe(0)
    await configure({ sessionId: "session", root })
    expect(values.get(storageKey("session"))).toBe(root)
    expect(await commands.get("obsidian.configuration")!({ sessionId: "session" })).toBe(root)
    expect(tools.map((tool) => tool.id)).toEqual(["obsidian_list", "obsidian_read", "obsidian_write"])
    const context = { signal: new AbortController().signal, session: { id: "session", repository: { name: "repo", path: "/repo" } } }
    const read = tools.find((tool) => tool.id === "obsidian_read")!
    const write = tools.find((tool) => tool.id === "obsidian_write")!
    await expect(read.execute({ path: "note.md" }, { ...context, session: { ...context.session, id: "missing" } })).rejects.toThrow("route")
    await expect(read.execute({ path: "note.md" }, { ...context, session: { ...context.session, repository: { name: "other", path: "/repo" } } })).rejects.toThrow("route")
    const result = await read.execute({ path: "note.md", sessionId: "missing" }, context)
    expect(result).toMatchObject({ content: "original", vault: root })
    const note = await readNote(root, "note.md")
    await write.execute({ path: "note.md", content: "agent update", vault: root, revision: note.revision }, context)
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("agent update")
    await expect(write.execute({ path: "note.md", content: "stale", vault: root, revision: note.revision }, context)).rejects.toThrow("Revision conflict")
    await expect(write.execute({ path: "note.md", content: "bad", vault: "/other", revision: "rev" }, context)).rejects.toThrow("Vault changed")
    expect(write.risk).toBe("mutate")
    expect(read.risk).toBe("read")
  } finally { await rm(root, { recursive: true, force: true }) }
})
