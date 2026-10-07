import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { afterEach, expect, it } from "vitest"
import { activateWithContext, storageKey } from "../../../../../plugins/obsidian/src/main.js"
import type { AgentToolDefinition, SessionSnapshot } from "../../../../plugin-sdk/src/host.js"
import { ToolRegistry } from "../tools/tool-registry.js"
import { inactiveRuntimeActivity, type AgentRuntimeContext } from "./agent-runtime.js"
import { executeRegistryTool } from "./registry-tool-bridge.js"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const setup = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "obsidian-bridge-")))
  roots.push(root)
  let tools: readonly AgentToolDefinition[] = []
  const values = new Map<string, unknown>([[storageKey("session"), root]])
  // SAFETY: The host consumes only these session fields.
  const snapshot = { id: "session", repo: "repo" } as SessionSnapshot
  await activateWithContext({
    sessions: { get: async () => snapshot },
    storage: {
      keys: async () => [...values.keys()],
      // SAFETY: Mirrors PluginStorage's caller-owned generic read contract.
      get: async <T>(key: string) => values.get(key) as T | undefined,
      set: async (key, value) => { values.set(key, value) },
      delete: async (key) => { values.delete(key) }
    },
    subscriptions: [], commands: { register: () => ({ dispose() {} }) },
    agentTools: { registerToolset: (set) => { tools = set.tools; return { dispose() {} } } }
  })
  const registry = new ToolRegistry()
  for (const tool of tools) registry.register({
    ...tool, version: "1", input: Schema.Unknown, roles: ["conversation"], modes: ["auto"],
    timeoutMs: 30_000, outputBudget: tool.outputBudget!, cancellable: true, idempotency: tool.idempotency!,
    execute: async (input, execution) => tool.execute(input, { signal: execution.signal, session: { id: "session", repository: { name: "repo", path: "/repo" } } })
  })
  const context: AgentRuntimeContext = {
    ...inactiveRuntimeActivity, canUseTool: () => Effect.succeed("allow"),
    askQuestion: () => Effect.succeed([]), publishEvent: () => Effect.void
  }
  const call = async (id: string, parameters: unknown) => {
    const result = await executeRegistryTool({ registry, context, spec: { role: "conversation", mode: "auto" }, id,
      parameters, allowed: true, toolCallId: crypto.randomUUID(), signal: undefined, onUpdate: undefined })
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(30_000)
    return result
  }
  return { root, call }
}

it("retains revision and reconstructs a large escaped note through executeRegistryTool", async () => {
  const { root, call } = await setup()
  const content = "\0\n\t\"\\💡".repeat(6_000)
  await writeFile(join(root, "note.md"), content)
  let offset: number | null = 0
  let revision: string | undefined
  let reconstructed = ""
  while (offset !== null) {
    const result = await call("obsidian_read", { path: "note.md", offset, ...(revision ? { revision } : {}) })
    expect(result.details.status).toBe("success")
    const page = JSON.parse(result.content[0]!.text)
    expect(page.revision).toMatch(/^[a-f0-9]{64}$/u)
    if (revision) expect(page.revision).toBe(revision)
    revision = page.revision
    expect(page.offset).toBe(offset)
    expect(page.total).toBe(content.length)
    reconstructed += page.content
    offset = page.nextOffset
  }
  expect(reconstructed).toBe(content)
  await writeFile(join(root, "note.md"), "external")
  const stale = await call("obsidian_read", { path: "note.md", offset: 0, revision })
  expect(stale.details.status).toBe("error")
  expect(stale.content[0]!.text).toContain("Revision conflict")
  const invalid = await call("obsidian_read", { path: "note.md", offset: -1 })
  expect(invalid.details.status).toBe("error")
})

it("paginates large escaped listings without truncating rendered JSON", async () => {
  const { root, call } = await setup()
  const names = Array.from({ length: 230 }, (_, index) => `${String(index).padStart(3, "0")}-${'"'.repeat(180)}.md`)
  await Promise.all(names.map((name) => writeFile(join(root, name), "note")))
  let offset: number | null = 0
  const listed: string[] = []
  let pages = 0
  while (offset !== null) {
    const result = await call("obsidian_list", { offset })
    expect(result.details.status).toBe("success")
    const page = JSON.parse(result.content[0]!.text)
    expect(page.total).toBe(names.length)
    expect(page.notes.length).toBeGreaterThan(0)
    listed.push(...page.notes)
    offset = page.nextOffset
    pages++
  }
  expect(pages).toBeGreaterThan(2)
  expect(listed).toEqual(names)
})
