import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnectionId,
  ProviderModelId
} from "@jingler/core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { AgentTurnSpec } from "./agent-turn-driver.js"
import { attachMemoryToSessionSpec } from "./memory-session.js"

const spec: AgentTurnSpec = {
  sessionId: "session-1",
  chatId: "chat-1",
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("openai-codex"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("openai/gpt-5.6-sol"),
  role: "background",
  priorMessages: [],
  piSessionId: null,
  seed: null,
  targetCapabilities: {
    versions: CURRENT_RUNTIME_CONTRACTS,
    toolIds: [],
    resourceIds: [],
    targetId: "desktop"
  },
  cwd: "/tmp/jingler",
  prompt: "Implement the assigned stage.",
  images: [],
  mode: "auto"
}

describe("attachMemoryToSessionSpec", () => {
  it("loads memory instructions and the MCP server into an independent worker", () => {
    const enriched = attachMemoryToSessionSpec(spec, {
      server: {
        name: "jingler-memory",
        url: "http://127.0.0.1:9000/mcp",
        headers: { authorization: "Bearer scoped" }
      },
      instructions: "<team-memory>Recall first.</team-memory>"
    })

    expect(enriched.prompt).toBe(
      "<team-memory>Recall first.</team-memory>\n\nImplement the assigned stage."
    )
    expect(enriched.mcp?.memory?.name).toBe("jingler-memory")
  })

  it("preserves the original spec when memory is unavailable", () => {
    expect(attachMemoryToSessionSpec(spec, null)).toBe(spec)
  })
})
