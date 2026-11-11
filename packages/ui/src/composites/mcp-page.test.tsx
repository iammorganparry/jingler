import type { ClaudeConnector, McpImportCandidateView, McpRegistryEntry, McpServer, McpServerStatus } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { mcpCatalog, mcpRows } from "./mcp-page.js"

const server = (name: string, over: Partial<McpServer> = {}): McpServer => ({
  name, displayName: name, iconUrl: null, authKind: "none", authState: "not-required", transport: "http",
  scope: "user", target: `https://${name}.example/mcp`, envKeys: [], headerKeys: [], enabled: true, ...over
})
const status = (name: string, state: McpServerStatus["state"], toolCount: number | null = null): McpServerStatus => ({
  name, scope: "user", state, toolCount, toolNames: [], error: null, checkedAt: "2026-11-10T00:00:00.000Z"
})
const connector = (name: string, over: Partial<ClaudeConnector> = {}): ClaudeConnector => ({
  name: `claude.ai ${name}`, url: `https://${name.toLowerCase()}.example/mcp`, state: "needs-auth", duplicate: false, ...over
})

describe("mcpRows", () => {
  it("merges mcp.json servers with probe state and drops duplicate claude.ai connectors", () => {
    const rows = mcpRows(
      [server("paper"), server("sentry", { authKind: "oauth", authState: "needs-auth" })],
      [status("paper", "connected", 24)],
      [connector("Linear"), connector("Sentry", { duplicate: true })]
    )
    expect(rows.map(({ id, source, state, toolCount }) => [id, source, state, toolCount])).toEqual([
      ["paper", "jingler", "connected", 24],
      ["sentry", "jingler", "needs-auth", null],
      ["claude.ai:claude.ai Linear", "claude.ai", "needs-auth", null]
    ])
    expect(rows[2]).toMatchObject({ displayName: "Linear", agents: "Claude" })
  })

  it("shows one row per URL: an unsigned copy hides behind the claude.ai connector", () => {
    const rows = mcpRows(
      [server("gdocs", { authKind: "oauth", authState: "needs-auth", target: "https://docs.example/mcp/" })],
      null,
      [connector("Docs", { state: "connected" })]
    )
    expect(rows.map(({ id, source, state, jinglerCopy }) => [id, source, state, jinglerCopy])).toEqual([
      ["claude.ai:claude.ai Docs", "claude.ai", "connected", "gdocs"]
    ])
  })

  it("treats a 401 probe on a no-auth server as needs sign-in", () => {
    expect(mcpRows([server("posthog")], [status("posthog", "needs-auth")], [])[0]?.state).toBe("needs-auth")
  })
})

describe("mcpCatalog", () => {
  const registry: McpRegistryEntry = {
    registryName: "app.linear/linear", name: "linear", displayName: "Linear", description: "Issues", iconUrl: null,
    kind: "Remote", problem: null, entry: { type: "remote", url: "https://mcp.linear.app/mcp", headers: {}, enabled: true }
  }
  const candidate: McpImportCandidateView = {
    name: "context7", source: "codex", origin: "user", target: "https://mcp.context7.com/mcp", problem: null, needsSignIn: false, needsSecrets: false
  }

  it("orders claude.ai, harness and registry entries and maps each to its add action", () => {
    const { entries, actions } = mcpCatalog([], [], [connector("Slack")], [candidate], [registry])
    expect(entries.map(({ id, origin }) => [id, origin])).toEqual([
      ["ca:claude.ai Slack", "claude.ai"],
      ["codex:context7", "codex"],
      ["rg:app.linear/linear", "registry"]
    ])
    expect(actions.get("codex:context7")).toEqual({ kind: "import", source: "codex", name: "context7" })
    expect(actions.get("rg:app.linear/linear")).toEqual({ kind: "registry", entry: registry })
    expect(actions.has("ca:claude.ai Slack")).toBe(false)
  })

  it("marks registry entries already in mcp.json by URL, and hides unimportable candidates", () => {
    const servers = [server("my-linear", { target: "https://mcp.linear.app/mcp/" })]
    const rows = mcpRows(servers, [status("my-linear", "connected", 9)], [])
    const { entries } = mcpCatalog(servers, rows, [], [{ ...candidate, problem: "SSE" }], [registry])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ added: "connected", displayName: "my-linear" })
  })
})
