import type { Activate, AgentToolDefinition, HostContext } from "@jingler/plugin-sdk/host"
import { listNotes, readNote, validateRoot, writeNote } from "./vault.js"

export const storageKey = (id: string) => `vault:${id}`
function input(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected an object.")
  return raw as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("A nonempty string is required.")
  return value
}

type VaultHost = Pick<HostContext, "sessions" | "storage" | "commands" | "agentTools" | "subscriptions">
export const activateWithContext = async (ctx: VaultHost) => {
  const configurations = new Map<string, { root: string }>()
  const session = async (id: unknown) => {
    const sessionId = text(id)
    if (!(await ctx.sessions.get(sessionId))) throw new Error("Unknown session.")
    return sessionId
  }
  const rootFor = async (id: unknown) => {
    const sessionId = await session(id)
    return validateRoot(await ctx.storage.get(storageKey(sessionId)))
  }
  const commands: Record<string, (raw: unknown) => Promise<unknown>> = {
    "obsidian.configuration": async (raw) => {
      const id = await session(input(raw).sessionId)
      const saved = await ctx.storage.get(storageKey(id))
      return saved === undefined ? "" : validateRoot(saved)
    },
    "obsidian.configure": async (raw) => {
      const args = input(raw)
      const id = await session(args.sessionId)
      const root = await validateRoot(args.root)
      const previous = configurations.get(id)
      configurations.set(id, { root })
      try { await ctx.storage.set(storageKey(id), root) } catch (cause) {
        if (previous) configurations.set(id, { ...previous })
        else configurations.delete(id)
        throw cause
      }
      return root
    },
    "obsidian.list": async (raw) => listNotes(await rootFor(input(raw).sessionId)),
    "obsidian.read": async (raw) => {
      const args = input(raw)
      return readNote(await rootFor(args.sessionId), text(args.path))
    }
  }
  for (const [id, handler] of Object.entries(commands)) ctx.subscriptions.push(ctx.commands.register(id, handler))
  ctx.subscriptions.push(ctx.agentTools.registerToolset({ id: "obsidian.vault", tools: vaultTools(ctx, rootFor, configurations) }))
}
export const activate: Activate = activateWithContext

const MAX_RESULT = 30_000 // Leave room below the runtime bridge's 32,000-character cap.
function bounded<T>(result: T): T {
  if (JSON.stringify(result).length > MAX_RESULT) throw new Error("Vault metadata exceeds the agent response limit.")
  return result
}
function pageOffset(value: unknown, total: number): number {
  const offset = value ?? 0
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error("Invalid page offset.")
  return offset
}
function listPage(root: string, paths: string[], rawOffset: unknown) {
  const offset = pageOffset(rawOffset, paths.length)
  const result = { vault: root, offset, total: paths.length, nextOffset: offset < paths.length ? offset : null as number | null, notes: [] as string[] }
  bounded(result)
  for (const path of paths.slice(offset, offset + 100)) {
    result.notes.push(path)
    result.nextOffset = offset + result.notes.length < paths.length ? offset + result.notes.length : null
    if (JSON.stringify(result).length > MAX_RESULT) {
      result.notes.pop()
      result.nextOffset = offset + result.notes.length
      if (!result.notes.length) throw new Error("Note path exceeds the agent response limit.")
      break
    }
  }
  return bounded(result)
}
async function readPage(root: string, path: string, args: Record<string, unknown>) {
  const note = await readNote(root, path)
  if (args.revision !== undefined && args.revision !== note.revision) throw new Error("Revision conflict: restart reading at offset 0.")
  const offset = pageOffset(args.offset, note.content.length)
  let end = Math.min(offset + 4_000, note.content.length)
  const result = { vault: root, path, revision: note.revision, offset, total: note.content.length, nextOffset: end < note.content.length ? end : null as number | null, content: note.content.slice(offset, end) }
  while (JSON.stringify(result).length > MAX_RESULT && end > offset) {
    end = offset + Math.floor((end - offset) / 2)
    result.content = note.content.slice(offset, end)
    result.nextOffset = end < note.content.length ? end : null
  }
  if (end === offset && offset < note.content.length) throw new Error("Vault metadata exceeds the agent response limit.")
  return bounded(result)
}
function vaultTools(ctx: VaultHost, rootFor: (id: unknown) => Promise<string>, configurations: Map<string, { root: string }>): AgentToolDefinition[] {
  const writeProperties = { content: { type: "string" }, revision: { type: "string" }, vault: { type: "string" } }
  return ["list", "read", "write"].map((action): AgentToolDefinition => ({
    id: `obsidian_${action}`,
    description: action === "write"
      ? "Update an existing .md note. Supply the revision from obsidian_read; conflicts require re-reading. The vault must match the root returned by list/read."
      : `Obsidian: ${action} Markdown notes in this session's configured local vault. Responses are paginated: use nextOffset until null. Reads include revision on every page; supply it on subsequent reads to avoid mixing versions.`,
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        ...(action === "list" ? {} : { path: { type: "string" } }),
        ...(action === "write" ? writeProperties : { offset: { type: "integer", minimum: 0 }, ...(action === "read" ? { revision: { type: "string" } } : {}) })
      },
      required: { list: [], read: ["path"], write: ["path", "content", "revision", "vault"] }[action]
    },
    risk: action === "write" ? "mutate" : "read",
    idempotency: action === "write" ? "unsafe" : "safe",
    outputBudget: MAX_RESULT,
    execute: async (raw, context) => {
      context.signal.throwIfAborted()
      const actual = await ctx.sessions.get(context.session.id)
      if (!actual || actual.repo !== context.session.repository.name) throw new Error("Session route does not match.")
      const configuration = configurations.get(actual.id)
      const root = await rootFor(actual.id)
      const args = input(raw)
      if (action === "list") return listPage(root, await listNotes(root), args.offset)
      const path = text(args.path)
      if (action === "write") {
        const checkConfiguration = () => {
          const current = configurations.get(actual.id)
          if (args.vault !== root || current !== configuration || (current && current.root !== root)) {
            throw new Error("Vault changed: list/read again before writing.")
          }
        }
        checkConfiguration()
        bounded({ vault: root, path, revision: "0".repeat(64) })
        const note = await writeNote(root, path, args.content, args.revision, context.signal, checkConfiguration)
        return { vault: root, path: note.path, revision: note.revision }
      }
      return readPage(root, path, args)
    }
  }))
}
