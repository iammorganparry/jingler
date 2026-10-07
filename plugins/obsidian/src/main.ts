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
      await ctx.storage.set(storageKey(id), root)
      return root
    },
    "obsidian.list": async (raw) => listNotes(await rootFor(input(raw).sessionId)),
    "obsidian.read": async (raw) => {
      const args = input(raw)
      return readNote(await rootFor(args.sessionId), text(args.path))
    }
  }
  for (const [id, handler] of Object.entries(commands)) ctx.subscriptions.push(ctx.commands.register(id, handler))
  ctx.subscriptions.push(ctx.agentTools.registerToolset({ id: "obsidian.vault", tools: vaultTools(ctx, rootFor) }))
}
export const activate: Activate = activateWithContext

function vaultTools(ctx: VaultHost, rootFor: (id: unknown) => Promise<string>): AgentToolDefinition[] {
  const writeProperties = { content: { type: "string" }, revision: { type: "string" }, vault: { type: "string" } }
  return ["list", "read", "write"].map((action): AgentToolDefinition => ({
    id: `obsidian_${action}`,
    description: action === "write"
      ? "Update an existing .md note. Supply the revision from obsidian_read; conflicts require re-reading. The vault must match the root returned by list/read."
      : `Obsidian: ${action} Markdown notes in this session's configured local vault.`,
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: action === "list" ? {} : {
        path: { type: "string" },
        ...(action === "write" ? writeProperties : {})
      },
      required: { list: [], read: ["path"], write: ["path", "content", "revision", "vault"] }[action]
    },
    risk: action === "write" ? "mutate" : "read",
    idempotency: action === "write" ? "unsafe" : "safe",
    outputBudget: 1_100_000,
    execute: async (raw, context) => {
      context.signal.throwIfAborted()
      const actual = await ctx.sessions.get(context.session.id)
      if (!actual || actual.repo !== context.session.repository.name) throw new Error("Session route does not match.")
      const root = await rootFor(actual.id)
      const args = input(raw)
      if (action === "list") return { vault: root, notes: await listNotes(root) }
      const path = text(args.path)
      if (action === "write") {
        if (args.vault !== root) throw new Error("Vault changed: list/read again before writing.")
        return { vault: root, ...await writeNote(root, path, args.content, args.revision) }
      }
      return { vault: root, ...await readNote(root, path) }
    }
  }))
}
