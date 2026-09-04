import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { estimatePiContextBreakdown } from "./pi-context-breakdown.js"

describe("estimatePiContextBreakdown", () => {
  it("separates MCP and skill payloads and scales them to the provider total", () => {
    const session = {
      systemPrompt: "system instructions",
      getActiveToolNames: () => ["read", "mcp_search", "mcp_call"],
      getAllTools: () => [
        { name: "read", description: "Read a file", parameters: {} },
        { name: "mcp_search", description: "Discover MCP tools", parameters: {} },
        { name: "mcp_call", description: "Call an MCP tool", parameters: {} }
      ],
      messages: [
        { role: "user", content: "Use the team conventions" },
        { role: "assistant", content: [{ type: "toolCall", name: "jingler_load_resource", arguments: { id: "skill" } }] },
        { role: "toolResult", toolName: "jingler_load_resource", content: [{ type: "text", text: "SKILL.md guidance" }] },
        { role: "assistant", content: [{ type: "toolCall", name: "mcp_call", arguments: { server: "linear" } }] }
      ]
    } as unknown as Pick<AgentSession, "systemPrompt" | "getActiveToolNames" | "getAllTools" | "messages">

    const result = estimatePiContextBreakdown(session, 12_000)

    expect(result.skills).toBeGreaterThan(0)
    expect(result.mcps).toBeGreaterThan(0)
    expect(Object.values(result).reduce((sum, value) => sum + value, 0)).toBe(12_000)
  })
})
