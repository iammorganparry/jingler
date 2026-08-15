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

const attachment = {
  server: {
    name: "jingler-memory",
    url: "http://127.0.0.1:9000/mcp",
    headers: { authorization: "Bearer scoped" }
  },
  instructions: "<team-memory>Recall first.</team-memory>"
}

describe("attachMemoryToSessionSpec", () => {
  it("loads memory instructions and the MCP server into an independent worker", () => {
    const enriched = attachMemoryToSessionSpec(spec, attachment)

    expect(enriched.prompt).toBe(
      "<team-memory>Recall first.</team-memory>\n\nImplement the assigned stage."
    )
    expect(enriched.mcp?.memory?.name).toBe("jingler-memory")
  })

  it.each(["conversation", "plan", "plan-execution", "review", "background"] as const)(
    "attaches memory for the %s PI role",
    (role) => {
      const enriched = attachMemoryToSessionSpec({ ...spec, role }, attachment)
      expect(enriched.mcp?.memory?.name).toBe("jingler-memory")
      expect(enriched.prompt).toContain("<team-memory>")
    }
  )

  it("keeps command-led prompts first while attaching memory", () => {
    const enriched = attachMemoryToSessionSpec({ ...spec, prompt: "/review now" }, attachment)
    expect(enriched.prompt.startsWith("/review now")).toBe(true)
    expect(enriched.prompt).toContain("<team-memory>")
  })

  it("excludes context-digest runs from team memory", () => {
    const digest = { ...spec, role: "context-digest" as const }
    expect(attachMemoryToSessionSpec(digest, attachment)).toBe(digest)
  })

  it("preserves the original spec when memory is unavailable", () => {
    expect(attachMemoryToSessionSpec(spec, null)).toBe(spec)
  })
})
