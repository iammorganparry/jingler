import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { verdict } from "../../approvals.js"
import { isReadOnlyCommand } from "./plan-policy.js"
import { ToolRegistry, type ToolDefinition } from "./tool-registry.js"

const ALL_ROLES = ["conversation", "plan", "plan-execution", "review", "background"] as const
const ALL_MODES = ["ask", "accept-edits", "auto", "plan", "read-only"] as const

const tool = (id: string, risk: ToolDefinition<unknown>["risk"], origin?: ToolDefinition<unknown>["origin"]): ToolDefinition<unknown> => ({
  id, version: "1", description: id, input: Schema.Unknown, risk, roles: ALL_ROLES, modes: ALL_MODES,
  timeoutMs: 1000, outputBudget: 1000, cancellable: false, idempotency: "safe", execute: async () => "ran",
  ...(origin ? { origin } : {})
})

const registry = () => {
  const r = new ToolRegistry()
  for (const t of [
    tool("workspace_read_file", "read"), tool("mcp_search", "network"), tool("mcp_call", "execute"),
    tool("plugin_read", "read", { kind: "plugin", pluginId: "p", toolsetId: "t" }),
    tool("plugin_mutate", "mutate", { kind: "plugin", pluginId: "p", toolsetId: "t" }),
    tool("code_edit", "mutate"), tool("subagent_writer", "execute"),
    tool("workspace_write", "mutate"), tool("workspace_edit", "mutate"), tool("command_execute", "execute")
  ]) r.register(t)
  return r
}

const planIds = (r: ToolRegistry) => r.capabilitiesFor("plan", "plan").map(({ id }) => id).sort()

describe("plan-mode enforcement matrix (Pi tool registry)", () => {
  it("exposes only reads, discovery, and the path-checked scoped tools", () => {
    expect(planIds(registry())).toEqual(
      ["command_execute", "mcp_search", "plugin_read", "workspace_edit", "workspace_read_file", "workspace_write"]
    )
  })

  it.each(["mcp_call", "plugin_mutate", "code_edit", "subagent_writer"])("denies %s", async (id) => {
    const result = await Effect.runPromise(registry().execute({ id, arguments: {}, role: "plan", mode: "plan" }))
    expect(result.status).toBe("error")
  })

  it("denies mode=plan even when the role was left as conversation", () => {
    expect(registry().capabilitiesFor("conversation", "plan").map(({ id }) => id)).not.toContain("mcp_call")
  })

  it("allows reads", async () => {
    const result = await Effect.runPromise(registry().execute({ id: "workspace_read_file", arguments: {}, role: "plan", mode: "plan" }))
    expect(result.status).toBe("success")
  })
})

describe("plan-mode bash allowlist", () => {
  it.each(["ls -la", "cat a.md", "rg foo src", "grep -rn x .", "git status", "git diff", "git log", "git show HEAD", "git branch -a", "pwd", "echo hi", "wc -l a", "find . -name x"])("allows %s", (c) => {
    expect(isReadOnlyCommand(c)).toBe(true)
  })

  it.each([
    "echo hi > a.md", "echo hi >> a", "cat a | tee b", "ls | xargs rm", "rm -rf x", "mv a b", "cp a b",
    "git commit -am x", "git push", "git checkout main", "git reset --hard", "git branch -D x",
    "npm install", "pnpm add x", "curl https://x", "wget https://x", "echo $(rm a)", "echo `rm a`",
    "find . -delete", "find . -exec rm {} ;", "ls; rm a", "ls && rm a", "rg --pre sh x", "git diff --ext-diff", ""
  ])("denies %s", (c) => {
    expect(isReadOnlyCommand(c)).toBe(false)
  })
})

describe("plan-mode approvals", () => {
  it("denies edits and commands", () => {
    expect(verdict("plan", new Set(["git commit"]), { kind: "command", tool: "Bash", target: null, command: "git commit -m x" })).toBe("deny")
    expect(verdict("plan", new Set(), { kind: "edit", tool: "Edit", target: "AGENTS.md", command: null })).toBe("deny")
  })
})
