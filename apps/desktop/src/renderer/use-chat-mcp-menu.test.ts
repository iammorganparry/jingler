import type { McpConnectorRow } from "@jingler/ui"
import { describe, expect, it } from "vitest"
import { chatMcpKey, chatMcpRows, toggleChatMcp } from "./use-chat-mcp-menu.js"

const row = (id: string, over: Partial<McpConnectorRow> = {}): McpConnectorRow => ({
  id, displayName: id, iconUrl: null, target: "", source: "jingler", agents: "All agents",
  state: "connected", toolCount: 1, enabled: true, ...over
})

describe("per-chat MCP menu", () => {
  it("keys claude.ai rows by their CLI name and mcp.json rows by name", () => {
    expect(chatMcpKey(row("claude.ai:claude.ai Linear", { source: "claude.ai" }))).toBe("claude.ai Linear")
    expect(chatMcpKey(row("paper"))).toBe("paper")
  })

  it("shows a server off when the chat or the global switch disables it", () => {
    const rows = chatMcpRows([row("paper"), row("sentry"), row("off", { enabled: false })], ["sentry"])
    expect(rows.map(({ id, enabled }) => [id, enabled])).toEqual([["paper", true], ["sentry", false], ["off", false]])
  })

  it("toggles names in and out of the disabled list without duplicates", () => {
    expect(toggleChatMcp(["a"], "a", false)).toEqual(["a"])
    expect(toggleChatMcp([], "a", false)).toEqual(["a"])
    expect(toggleChatMcp(["a", "b"], "a", true)).toEqual(["b"])
  })
})
